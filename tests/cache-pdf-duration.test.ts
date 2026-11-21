import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/core/cache.ts";
import { downloadOrderPdfs } from "../src/core/pdf.ts";
import { caseDurationDays, withContentHash } from "../src/parsers/hcservices-case.ts";
import type { CaseResult } from "../src/core/types.ts";

describe("TtlCache", () => {
  test("caches, expires, never caches failures", async () => {
    let t = 0, calls = 0;
    const c = new TtlCache<number>(1000, 10, () => t);
    assert.deepEqual(await c.wrap("k", async () => ++calls), { value: 1, cached: false });
    assert.deepEqual(await c.wrap("k", async () => ++calls), { value: 1, cached: true });
    t = 1001;
    assert.deepEqual(await c.wrap("k", async () => ++calls), { value: 2, cached: false });
    await assert.rejects(c.wrap("bad", async () => { throw new Error("x"); }));
    assert.equal(c.get("bad"), undefined);
    assert.deepEqual(await c.wrap("bad", async () => 9), { value: 9, cached: false });
  });
  test("simultaneous requests share one upstream call", async () => {
    const c = new TtlCache<number>(1000);
    let calls = 0;
    const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 7; };
    const [a, b, d] = await Promise.all([c.wrap("k", slow), c.wrap("k", slow), c.wrap("k", slow)]);
    assert.equal(calls, 1);
    assert.deepEqual([a.value, b.value, d.value], [7, 7, 7]);
  });
  test("evicts the oldest entry past max", () => {
    const c = new TtlCache<number>(1000, 2);
    c.set("a", 1); c.set("b", 2); c.set("c", 3);
    assert.deepEqual([c.get("a"), c.get("b"), c.get("c")], [undefined, 2, 3]);
  });
});

describe("downloadOrderPdfs", () => {
  test("saves what works, records what fails, skips orders without links or already saved", async () => {
    const c = { cnr: "KAHC010112112026", warnings: [] as string[], orders: [
      { number: "1", fileUrl: "https://x/1.pdf" }, { number: "2", fileUrl: "https://x/dead.pdf" },
      { number: "3" }, { number: "4", fileUrl: "https://x/4.pdf", localPath: "already" },
    ] as any[] };
    const seen: string[] = [];
    const r = await downloadOrderPdfs(c, { runId: "r", runsDir: "/tmp", download: async ({ url, name }) => { seen.push(name); return url.includes("dead") ? { error: "not a PDF (12 bytes)" } : { localPath: `/saved/${name}.pdf` }; } });
    assert.deepEqual(r, { saved: 1, failed: 1 });
    assert.equal(c.orders[0].localPath, "/saved/KAHC010112112026-order-1.pdf");
    assert.equal(c.orders[1].localPath, undefined);
    assert.match(c.warnings[0], /order 2: PDF not saved — not a PDF/);
    assert.equal(seen.length, 2);
  });
  test("respects the limit", async () => {
    const orders = Array.from({ length: 5 }, (_, i) => ({ number: String(i), fileUrl: `https://x/${i}.pdf` }));
    const r = await downloadOrderPdfs({ orders }, { runId: "r", runsDir: "/tmp", limit: 2, download: async () => ({ localPath: "p" }) });
    assert.equal(r.saved, 2);
  });
});

describe("case duration", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  test("disposed: filing → decision", () => assert.equal(caseDurationDays({ filingDate: "01/01/2026", decisionDate: "2026-01-31" }, now), 30));
  test("pending: filing → today", () => assert.equal(caseDurationDays({ filingDate: "2026-11-01" }, now), 20));
  test("falls back to registration date", () => assert.equal(caseDurationDays({ registrationDate: "2026-11-11" }, now), 10));
  test("no usable dates, or end before start → undefined", () => {
    assert.equal(caseDurationDays({}, now), undefined);
    assert.equal(caseDurationDays({ filingDate: "2026-12-01", decisionDate: "2026-01-01" }, now), undefined);
  });
  test("duration is not part of the content hash (it changes every day)", () => {
    const base = { parties: [], advocates: [], hearings: [], documents: [], filingDate: "2020-01-01" } as unknown as CaseResult;
    const a = withContentHash(base), b = withContentHash({ ...base, caseDurationDays: 99999 });
    assert.equal(a.contentHash, b.contentHash);
    assert.ok(typeof a.caseDurationDays === "number");
  });
});
