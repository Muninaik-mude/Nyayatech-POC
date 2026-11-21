import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let q: typeof import("../src/core/queue.ts");
before(async () => {
  process.env.QUEUE_CONCURRENCY = "1"; // must be set before the module is first loaded
  q = await import("../src/core/queue.ts");
});

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };
const tick = () => new Promise((r) => setTimeout(r, 10));

test("queue position updates as jobs ahead of it start and finish", async () => {
  const g1 = gate(), g2 = gate(), g3 = gate();
  const a = q.enqueue(() => g1.p.then(() => "a"));
  const b = q.enqueue(() => g2.p.then(() => "b"));
  const c = q.enqueue(() => g3.p.then(() => "c"));
  await tick();

  const pos = () => [a, b, c].map((j) => q.getJob(j.jobId)!.position);
  const status = () => [a, b, c].map((j) => q.getJob(j.jobId)!.status);
  assert.deepEqual(status(), ["running", "queued", "queued"]);
  assert.deepEqual(pos(), [0, 1, 2]);

  g1.open(); await a.promise; await tick();
  assert.deepEqual(status(), ["done", "running", "queued"]);
  assert.deepEqual(pos(), [0, 0, 1], "c moved up to position 1 (it used to stay at 3 forever)");

  g2.open(); await b.promise; g3.open(); await c.promise;
  assert.deepEqual(status(), ["done", "done", "done"]);
  assert.equal(q.getJob(c.jobId)!.result, "c");
});

test("failed jobs record the error", async () => {
  const j = q.enqueue(async () => { throw new Error("boom"); });
  await j.promise;
  assert.deepEqual([q.getJob(j.jobId)!.status, q.getJob(j.jobId)!.error], ["failed", "boom"]);
});

test("job records survive a restart; unfinished ones are reported as interrupted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
  const write = (id: string, status: string, extra = {}) =>
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, status, position: 3, createdAt: 1, ...extra }));
  write("job_done", "done", { result: { ok: true } });
  write("job_running", "running");
  write("job_queued", "queued");
  fs.writeFileSync(path.join(dir, "job_corrupt.json"), "{not json");

  const r = q.initQueue(dir);
  assert.deepEqual(r, { restored: 3, interrupted: 2 });
  assert.equal(q.getJob("job_done")!.status, "done");
  assert.deepEqual(q.getJob("job_done")!.result, { ok: true });
  for (const id of ["job_running", "job_queued"]) {
    assert.equal(q.getJob(id)!.status, "failed");
    assert.match(q.getJob(id)!.error!, /interrupted/);
  }
  assert.equal(fs.existsSync(path.join(dir, "job_corrupt.json")), false, "unreadable record removed");

  // new jobs are mirrored to disk
  const j = q.enqueue(async () => 1);
  await j.promise; await q.flushPersistence();
  assert.ok(fs.existsSync(path.join(dir, `${j.jobId}.json`)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${j.jobId}.json`), "utf8")).status, "done");
  fs.rmSync(dir, { recursive: true, force: true });
});
