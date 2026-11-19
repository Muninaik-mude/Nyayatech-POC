import pLimit from "p-limit";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  position: number;       // queue position (0 = running)
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

// Max 5 CNR searches running at same time
const limit = pLimit(5);

const jobs = new Map<string, Job>();
let queueCounter = 0;

function newJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getQueuePosition(): number {
  // Count how many jobs are currently queued (not running/done/failed)
  let pos = 1;
  for (const job of jobs.values()) {
    if (job.status === "queued") pos++;
  }
  return pos;
}

export function enqueue<T>(task: () => Promise<T>): { jobId: string; promise: Promise<void> } {
  const jobId = newJobId();

  const job: Job = {
    id: jobId,
    status: "queued",
    position: getQueuePosition(),
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  const promise = limit(async () => {
    job.status = "running";
    job.position = 0;
    job.startedAt = Date.now();

    try {
      const result = await task();
      job.status = "done";
      job.result = result;
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
    } finally {
      job.finishedAt = Date.now();
      // Clean up finished jobs after 5 minutes
      setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
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
  return { queued, running, done, failed, concurrencyLimit: 5 };
}
