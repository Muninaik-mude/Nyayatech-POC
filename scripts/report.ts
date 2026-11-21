// npm run report — prints the measurement table from runs/runs.jsonl
import * as fs from "fs";
import * as path from "path";
import { buildReport, formatReport } from "../src/core/report.js";

const file = path.resolve(process.env.RUNS_DIR ?? "./runs", "runs.jsonl");
if (!fs.existsSync(file)) { console.error(`No run log at ${file}. Run some searches first.`); process.exit(1); }
const runs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
console.log(formatReport(buildReport(runs)));
