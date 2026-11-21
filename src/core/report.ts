import type { RunMetrics } from "./types.js";

// Measurement table (REVIEW feedback item 8 / sec 6.4): per portal + tier, how many runs succeeded,
// the captcha solve rate and timing. Only runs that carry per-run captcha counts are used for the
// solve rate — older logs had corrupt counters, so they are excluded rather than averaged in.
export interface ReportRow {
  portal: string; tier: string; runs: number; ok: number; successRate: number;
  captchaRuns: number; captchaAttempts: number; captchaAccepted: number; solveRate: number | null;
  medianSec: number | null; p90Sec: number | null;
}

const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
const r1 = (n: number | null) => n === null ? null : Math.round(n * 10) / 10;

export function buildReport(runs: RunMetrics[]): ReportRow[] {
  const groups = new Map<string, RunMetrics[]>();
  for (const r of runs) {
    if (!r || typeof r.portal !== "string") continue;
    const k = `${r.portal}\u0000${r.tier}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  return [...groups.entries()].map(([k, rs]) => {
    const [portal, tier] = k.split("\u0000");
    const okRuns = rs.filter((r) => r.ok);
    const secs = okRuns.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
    // Valid counts: attempts > 0 and accepted <= attempts (older logs violated this).
    const cap = rs.filter((r) => r.captchaAttempts > 0 && r.captchaSolves >= 0 && r.captchaSolves <= r.captchaAttempts);
    const attempts = cap.reduce((n, r) => n + r.captchaAttempts, 0);
    const accepted = cap.reduce((n, r) => n + r.captchaSolves, 0);
    return {
      portal, tier, runs: rs.length, ok: okRuns.length, successRate: Math.round((okRuns.length / rs.length) * 100),
      captchaRuns: cap.length, captchaAttempts: attempts, captchaAccepted: accepted,
      solveRate: attempts ? Math.round((accepted / attempts) * 100) : null,
      medianSec: r1(pct(secs, 0.5)), p90Sec: r1(pct(secs, 0.9)),
    };
  }).sort((a, b) => b.runs - a.runs);
}

// Sustainable-rate probe results (see scripts/rate-probe.ts): requests until the first block.
export function formatReport(rows: ReportRow[]): string {
  const head = "| portal | tier | runs | ok | success | captcha solve rate | median s | p90 s |\n|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) =>
    `| ${r.portal} | ${r.tier} | ${r.runs} | ${r.ok} | ${r.successRate}% | ${r.solveRate === null ? "n/a (no valid counts)" : `${r.solveRate}% (${r.captchaAccepted}/${r.captchaAttempts})`} | ${r.medianSec ?? "-"} | ${r.p90Sec ?? "-"} |`);
  return [head, ...body].join("\n");
}
