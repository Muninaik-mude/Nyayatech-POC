import pLimit from "p-limit";
import * as fs from "fs";
import * as path from "path";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  position: number;       // 0 = running (or finished); 1 = next to run, 2 = after that, …
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

export const CONCURRENCY = Math.max(1, parseInt(process.env.QUEUE_CONCURRENCY ?? "5", 10) || 5);
const JOB_TTL_MS = 5 * 60 * 1000;

const limit = pLimit(CONCURRENCY);
const jobs = new Map<string, Job>();
let jobsDir: string | undefined;

function newJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Position = place in line among queued jobs, oldest first. Recomputed on every change so
// a job's position drops as the jobs ahead of it start (it used to be set once and never updated).
function recomputePositions(): void {
  const queued = [...jobs.values()].filter((j) => j.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  queued.forEach((j, i) => { j.position = i + 1; });
  for (const j of jobs.values()) if (j.status !== "queued") j.position = 0;
}

// Job state is mirrored to disk so status survives a restart. This is NOT a durable queue:
// the work itself is a closure and cannot be resumed — see initQueue().
// Writes for one job are chained so they land in order (queued → running → done); independent
// fire-and-forget writes could finish out of order and leave a stale "running" record on disk.
const writes = new Map<string, Promise<void>>();

function chain(id: string, op: () => Promise<unknown>): void {
  const next = (writes.get(id) ?? Promise.resolve()).then(op).then(() => {}, () => {});
  writes.set(id, next);
  next.then(() => { if (writes.get(id) === next) writes.delete(id); });
}
function persist(job: Job): void {
  if (!jobsDir) return;
  const file = path.join(jobsDir, `${job.id}.json`);
  const snapshot = JSON.stringify(job); // snapshot now: the job object keeps changing
  chain(job.id, () => fs.promises.writeFile(file, snapshot));
}
function unpersist(id: string): void {
  if (!jobsDir) return;
  const file = path.join(jobsDir, `${id}.json`);
  chain(id, () => fs.promises.rm(file, { force: true }));
}

// Resolves when every queued disk write has finished (used by tests and graceful shutdown).
export async function flushPersistence(): Promise<void> {
  while (writes.size) await Promise.all([...writes.values()]);
}

// Call once at startup. Loads job records written by a previous process. Anything that was still
// queued/running when that process died is reported as failed ("interrupted") instead of
// vanishing, so a client polling /api/job/:id gets a truthful answer and can resubmit.
export function initQueue(dir: string): { restored: number; interrupted: number } {
  jobsDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  let restored = 0, interrupted = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Job;
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error = "interrupted: the server restarted before this job finished — resubmit it";
        job.finishedAt = Date.now();
        interrupted++;
      }
      job.position = 0;
      jobs.set(job.id, job);
      persist(job);
      setTimeout(() => { jobs.delete(job.id); unpersist(job.id); }, JOB_TTL_MS).unref();
      restored++;
    } catch {
      fs.rmSync(path.join(dir, name), { force: true }); // unreadable record
    }
  }
  return { restored, interrupted };
}

export function enqueue<T>(task: () => Promise<T>): { jobId: string; promise: Promise<void> } {
  const jobId = newJobId();

  const job: Job = { id: jobId, status: "queued", position: 0, createdAt: Date.now() };
  jobs.set(jobId, job);
  recomputePositions();
  persist(job);

  const promise = limit(async () => {
    job.status = "running";
    job.startedAt = Date.now();
    recomputePositions();
    persist(job);

    try {
      job.result = await task();
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
    } finally {
      job.finishedAt = Date.now();
      recomputePositions();
      persist(job);
      setTimeout(() => { jobs.delete(jobId); unpersist(jobId); }, JOB_TTL_MS).unref();
    }
  });

  return { jobId, promise };
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function getQueueStats() {
  let queued = 0, running = 0, done = 0, failed = 0;
  for (const job of jobs.values()) {
    if (job.status === "queued")  queued++;
    if (job.status === "running") running++;
    if (job.status === "done")    done++;
    if (job.status === "failed")  failed++;
  }
  return { queued, running, done, failed, concurrencyLimit: CONCURRENCY };
}
