import { RunMetrics, Tier, StepMetric, CaptchaProvider } from "./types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

export function newRunId(): string {
  return `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function peakMemoryMb(): number {
  const mem = process.memoryUsage();
  return Math.round(mem.rss / 1024 / 1024);
}

export function buildMetrics(opts: {
  runId: string;
  portal: string;
  tier: Tier;
  durationMs: number;
  responseBytes: number;
  captchaAttempts: number;
  captchaSolves: number;
  captchaProvider: CaptchaProvider;
  steps: StepMetric[];
  tierEscalations: RunMetrics["tierEscalations"];
  ok: boolean;
  error?: string;
}): RunMetrics {
  return {
    ...opts,
    timestamp: new Date().toISOString(),
    peakMemoryMb: peakMemoryMb(),
  };
}

export async function appendRunMetrics(metrics: RunMetrics, runsDir: string): Promise<void> {
  const jsonlPath = path.join(runsDir, "runs.jsonl");
  await fs.promises.mkdir(runsDir, { recursive: true });
  await fs.promises.appendFile(jsonlPath, JSON.stringify(metrics) + "\n");
}
