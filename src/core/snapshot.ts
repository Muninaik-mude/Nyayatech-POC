import * as fs from "fs";
import * as path from "path";

// Save raw HTML — only call this on failure for debugging; successes save JSON instead
export async function saveHtml(runId: string, name: string, html: string, runsDir: string): Promise<string> {
  const dir = path.join(runsDir, runId);
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${name.replace(/[^a-z0-9_-]/gi, "_")}.html`;
  const filepath = path.join(dir, filename);
  await fs.promises.writeFile(filepath, html, "utf8");
  return filepath;
}

// Save parsed case result as compact JSON (~1-2 KB vs ~25 KB for HTML)
export async function saveResult(runId: string, result: unknown, runsDir: string): Promise<string> {
  const dir = path.join(runsDir, runId);
  await fs.promises.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, "result.json");
  await fs.promises.writeFile(filepath, JSON.stringify(result), "utf8");
  return filepath;
}

export async function savePdf(runId: string, name: string, data: Buffer, runsDir: string): Promise<string> {
  const dir = path.join(runsDir, runId, "docs");
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${name.replace(/[^a-z0-9_-]/gi, "_")}.pdf`;
  const filepath = path.join(dir, filename);
  await fs.promises.writeFile(filepath, data);
  return filepath;
}

// Delete run folders older than maxAgeDays (default 7 days)
export async function cleanOldRuns(runsDir: string, maxAgeDays = 7): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  try {
    const entries = await fs.promises.readdir(runsDir);
    for (const name of entries) {
      if (!name.startsWith("run_")) continue;
      const fullPath = path.join(runsDir, name);
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
        deleted++;
      }
    }
  } catch {
    // runsDir doesn't exist yet — nothing to clean
  }
  return deleted;
}
