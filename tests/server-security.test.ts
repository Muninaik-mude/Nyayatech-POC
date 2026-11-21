import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Boots the real server and talks to it over HTTP. Only requests that are rejected BEFORE any
// portal/captcha call are sent, so this test touches no external service.
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-key-123";
let child: ChildProcess, runs: string;

const env = (extra: Record<string, string> = {}) => ({
  ...process.env, PORT: String(PORT), RUNS_DIR: runs, HOST: "127.0.0.1", RATE_LIMIT_PER_MIN: "40", ...extra,
});

before(async () => {
  runs = fs.mkdtempSync(path.join(os.tmpdir(), "srv-test-"));
  child = spawn("node", ["--import", "tsx", "src/server.ts"], { env: env({ API_KEYS: `${KEY},other-key` }), stdio: "pipe" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { child.kill(); fs.rmSync(runs, { recursive: true, force: true }); });

const auth = { "X-API-Key": KEY };
const post = (url: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(BASE + url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("the UI page is public; /api needs a key", async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/queue/stats`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/queue/stats`, { headers: { "X-API-Key": "wrong" } })).status, 401);
  assert.equal((await fetch(`${BASE}/api/queue/stats`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${BASE}/api/queue/stats`, { headers: { Authorization: `Bearer ${KEY}` } })).status, 200);
});

test("CORS is closed: no allow-origin header for a foreign origin", async () => {
  const r = await fetch(`${BASE}/api/queue/stats`, { headers: { ...auth, Origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("debug routes are off by default", async () => {
  assert.equal((await fetch(`${BASE}/api/debug/fetch?url=https://hcservices.ecourts.gov.in/`, { headers: auth })).status, 404);
});

test("invalid search input is rejected with reasons (400), before any portal is contacted", async () => {
  const r = await post("/api/quick", { court: "high_court", searchBy: "cnr", cnr: "not-a-cnr'; DROP" });
  assert.equal(r.status, 400);
  const j = await r.json() as { error: string; details: string[] };
  assert.equal(j.error, "invalid input");
  assert.ok(j.details.some((d) => d.startsWith("cnr must be")));
});

test("malformed JSON and oversized bodies are rejected", async () => {
  assert.equal((await post("/api/quick", "{not json")).status, 400);
  const big = await fetch(`${BASE}/api/quick`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ a: "x".repeat(50000) }) });
  assert.equal(big.status, 413);
});

test("cause-list routes validate input before contacting the portal", async () => {
  for (const url of ["/api/cause-list/ap/dates?type=Z", "/api/cause-list/ap/courts?type=D", "/api/cause-list/ap/courts?type=D&date=21-11-2026",
                     "/api/cause-list/ap?type=D&date=2026-11-21", "/api/cause-list/ap?type=D&date=2026-11-21&court=abc", "/api/cause-list/ap?type=D&date=2026-11-21&court=1;DROP"]) {
    const r = await fetch(BASE + url, { headers: auth });
    assert.equal(r.status, 400, url);
  }
  assert.equal((await fetch(BASE + "/api/cause-list/ap/dates")).status, 401, "needs a key like every /api route");
});

test("rate limit: 40/min on search routes, then 429 with Retry-After", async () => {
  // earlier tests already used part of the window for this key, so just exhaust it
  let last: Response | undefined;
  for (let i = 0; i < 45; i++) last = await post("/api/deep", { court: "bad" });
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers.get("retry-after")) > 0);
  // a different key has its own window
  assert.equal((await post("/api/deep", { court: "bad" }, { "X-API-Key": "other-key" })).status, 400);
});

test("refuses to listen on a public address without API_KEYS", () => {
  const r = spawnSync("node", ["--import", "tsx", "src/server.ts"], { env: env({ HOST: "0.0.0.0", PORT: String(PORT + 100), API_KEYS: "" }), encoding: "utf8", timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Refusing to listen on 0\.0\.0\.0 without API_KEYS/);
});
