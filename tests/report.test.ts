import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, formatReport } from "../src/core/report.ts";
import type { RunMetrics } from "../src/core/types.ts";

const run = (o: Partial<RunMetrics>): RunMetrics => ({ runId: "r", timestamp: "", portal: "hc", tier: "http", tierEscalations: [], durationMs: 5000, responseBytes: 1, peakMemoryMb: 1, captchaAttempts: 2, captchaSolves: 1, captchaProvider: "claude", steps: [], ok: true, ...o });

test("success rate, solve rate and percentiles per portal+tier", () => {
  const rows = buildReport([
    run({ durationMs: 4000 }), run({ durationMs: 6000, captchaAttempts: 1, captchaSolves: 1 }),
    run({ ok: false, captchaAttempts: 3, captchaSolves: 0 }), run({ portal: "other", durationMs: 1000 }),
  ]);
  const hc = rows.find((r) => r.portal === "hc")!;
  assert.deepEqual([hc.runs, hc.ok, hc.successRate], [3, 2, 67]);
  assert.deepEqual([hc.captchaAttempts, hc.captchaAccepted, hc.solveRate], [6, 2, 33]);
  assert.deepEqual([hc.medianSec, hc.p90Sec], [4, 6]);
  assert.equal(rows[0].portal, "hc", "sorted by run count");
});

test("corrupt old counters (solves > attempts, zero attempts) are excluded, not averaged in", () => {
  const [r] = buildReport([run({ captchaAttempts: 1, captchaSolves: 9 }), run({ captchaAttempts: 0, captchaSolves: 0 })]);
  assert.equal(r.solveRate, null);
  assert.match(formatReport([r]), /n\/a \(no valid counts\)/);
});

test("junk lines don't crash it", () => assert.deepEqual(buildReport([null as any, {} as any]), []));
