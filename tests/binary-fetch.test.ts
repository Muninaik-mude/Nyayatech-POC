import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { fetchBinary, isPdf, fetchImageBytes, detectImageType } from "../src/core/tiers.ts";
import { downloadPdf } from "../src/core/pdf.ts";

// A "PDF" containing every byte value — invalid UTF-8 in many places, like a real compressed PDF.
const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), allBytes, allBytes, Buffer.from("\n%%EOF")]);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

let server: http.Server, base: string, tmp: string;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
  server = http.createServer((req, res) => {
    if (req.url === "/order.pdf") { res.writeHead(200, { "Content-Type": "application/pdf" }); res.end(PDF); }
    else if (req.url === "/captcha.png") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PNG); } // wrong header on purpose
    else if (req.url === "/captcha.jpg") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(JPG); }
    else if (req.url === "/expired") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>Session expired</html>"); }
    else { res.writeHead(404); res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("the old path (response as text → Buffer) corrupts a PDF — this is the bug", () => {
  const roundTripped = Buffer.from(PDF.toString("utf8"));
  assert.notDeepEqual(roundTripped, PDF);
});

test("fetchBinary returns the exact bytes", async () => {
  const { bytes, contentType } = await fetchBinary(`${base}/order.pdf`);
  assert.deepEqual(bytes, PDF);
  assert.equal(contentType, "application/pdf");
  assert.ok(isPdf(bytes));
});

test("fetchBinary throws on HTTP errors", async () => {
  await assert.rejects(fetchBinary(`${base}/missing`), /HTTP 404/);
});

test("downloadPdf saves a byte-identical file", async () => {
  const { localPath, error } = await downloadPdf({ url: `${base}/order.pdf`, runId: "run_test", runsDir: tmp, name: "order_1" });
  assert.equal(error, undefined);
  assert.ok(localPath);
  assert.deepEqual(fs.readFileSync(localPath!), PDF);
});

test("downloadPdf refuses to store an HTML page as a .pdf", async () => {
  const { localPath, error } = await downloadPdf({ url: `${base}/expired`, runId: "run_test", runsDir: tmp, name: "order_2" });
  assert.equal(localPath, undefined);
  assert.match(error!, /not a PDF/);
  assert.equal(fs.existsSync(path.join(tmp, "run_test", "docs", "order_2.pdf")), false);
});

test("fetchImageBytes trusts the file's bytes, not the Content-Type header", async () => {
  assert.equal((await fetchImageBytes(`${base}/captcha.png`)).mediaType, "image/png");
  assert.equal((await fetchImageBytes(`${base}/captcha.jpg`)).mediaType, "image/jpeg");
});

test("fetchImageBytes rejects an HTML page served in place of the captcha (no LLM call is wasted on it)", async () => {
  await assert.rejects(fetchImageBytes(`${base}/expired`), /not an image.*<html>Session expired/);
});

test("detectImageType", () => {
  assert.equal(detectImageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(detectImageType(Buffer.from("<html>")), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});

test("fetchBinary stores Set-Cookie in the jar (AP keeps the captcha answer in the session)", async () => {
  const srv = http.createServer((_, res) => { res.writeHead(200, { "Set-Cookie": ["JSESSIONID=abc123; Path=/; HttpOnly", "x=1"], "Content-Type": "image/png" }); res.end(PNG); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const jar = new Map<string, string>();
  await fetchBinary(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, { cookieJar: jar });
  srv.close();
  assert.deepEqual([...jar], [["JSESSIONID", "abc123"], ["x", "1"]]);
});

test("downloadPdf can POST a form (AP serves order PDFs this way) and checks the %PDF header", async () => {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${req.headers["content-type"]} ${b}`);
      if (b.includes("fname=good")) { res.writeHead(200, { "Content-Type": "application/pdf" }); res.end(Buffer.from("%PDF-1.4 hello")); }
      else { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>expired</html>"); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/sdcorderpdf.action`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-"));
  const ok = await downloadPdf({ url, form: { year: "2019", fname: "good", otype: "68" }, runId: "r1", runsDir: dir, name: "x" });
  const bad = await downloadPdf({ url, form: { year: "2019", fname: "bad", otype: "68" }, runId: "r1", runsDir: dir, name: "y" });
  srv.close();
  assert.equal(seen[0], "POST /sdcorderpdf.action application/x-www-form-urlencoded year=2019&fname=good&otype=68");
  assert.ok(ok.localPath && fs.readFileSync(ok.localPath).toString().startsWith("%PDF-1.4"));
  assert.match(bad.error!, /not a PDF/);
  assert.equal(bad.localPath, undefined);
});
