import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const RUNS_DIR = path.resolve(process.env.RUNS_DIR ?? "./runs");
const jsonlPath = path.join(RUNS_DIR, "runs.jsonl");

interface Row {
  runId: string;
  timestamp: string;
  portal: string;
  tier: string;
  durationMs: number;
  responseBytes: number;
  peakMemoryMb: number;
  captchaAttempts: number;
  captchaSolves: number;
  ok: boolean;
  error?: string;
}

async function main() {
  if (!fs.existsSync(jsonlPath)) {
    console.log("No runs.jsonl found. Run some searches first.");
    return;
  }
  const lines = (await fs.promises.readFile(jsonlPath, "utf8")).trim().split("\n").filter(Boolean);
  const rows: Row[] = lines.map((l) => JSON.parse(l));

  console.log("\n=== Courts POC Benchmark Summary ===\n");
  console.log(`Total runs: ${rows.length}`);

  // Group by portal + tier
  const groups: Record<string, Row[]> = {};
  for (const row of rows) {
    const key = `${row.portal} / ${row.tier}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  const headers = ["Portal / Tier", "Runs", "Success%", "Avg ms", "Avg KB", "Avg MB", "Captcha%"];
  const widths = [40, 6, 9, 8, 8, 8, 10];

  const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w - 1) : s.padEnd(w);
  console.log(headers.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));

  for (const [key, group] of Object.entries(groups)) {
    const successes = group.filter((r) => r.ok);
    const pct = Math.round((successes.length / group.length) * 100);
    const avgMs = Math.round(successes.reduce((a, r) => a + r.durationMs, 0) / (successes.length || 1));
    const avgKb = (successes.reduce((a, r) => a + r.responseBytes, 0) / (successes.length || 1) / 1024).toFixed(1);
    const avgMb = (group.reduce((a, r) => a + r.peakMemoryMb, 0) / group.length).toFixed(1);
    const captchaRows = group.filter((r) => r.captchaAttempts > 0);
    const captchaPct = captchaRows.length
      ? Math.round((captchaRows.reduce((a, r) => a + r.captchaSolves, 0) / captchaRows.reduce((a, r) => a + r.captchaAttempts, 0)) * 100)
      : null;

    const cols = [
      key,
      String(group.length),
      `${pct}%`,
      `${avgMs}`,
      `${avgKb}KB`,
      `${avgMb}MB`,
      captchaPct !== null ? `${captchaPct}%` : "n/a",
    ];
    console.log(cols.map((c, i) => pad(c, widths[i])).join("  "));
  }

  console.log("\nAll runs saved in:", jsonlPath);
}

main().catch(console.error);
