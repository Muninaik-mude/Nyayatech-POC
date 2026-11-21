import { fetchBinary, isPdf } from "./tiers.js";
import { savePdf } from "./snapshot.js";

// Download a PDF as raw bytes and save it. Returns undefined (and why) instead of saving junk:
// portals answer an expired link with an HTML page, which must not be stored as a .pdf.
export async function downloadPdf(opts: {
  url: string;
  cookieJar?: Map<string, string>;
  runId?: string;
  runsDir?: string;
  name: string;
}): Promise<{ localPath?: string; error?: string }> {
  try {
    const { bytes } = await fetchBinary(opts.url, { cookieJar: opts.cookieJar, accept: "application/pdf,*/*" });
    if (!isPdf(bytes)) return { error: `not a PDF (${bytes.length} bytes, starts "${bytes.subarray(0, 20).toString("latin1").replace(/\s+/g, " ")}")` };
    if (!opts.runId || !opts.runsDir) return {};
    return { localPath: await savePdf(opts.runId, opts.name, bytes, opts.runsDir) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// Download the PDF of every order that has a link (max `limit`), set order.localPath, and record
// failures in case.warnings — a dead link must not fail the whole search.
export async function downloadOrderPdfs(
  c: { cnr?: string; orders?: { number: string; fileUrl?: string; localPath?: string }[]; warnings?: string[] },
  opts: { runId: string; runsDir: string; limit?: number; download?: typeof downloadPdf }
): Promise<{ saved: number; failed: number }> {
  const dl = opts.download ?? downloadPdf;
  let saved = 0, failed = 0;
  const todo = (c.orders ?? []).filter((o) => o.fileUrl && !o.localPath).slice(0, opts.limit ?? 10);
  for (const [i, o] of todo.entries()) {
    const r = await dl({ url: o.fileUrl!, runId: opts.runId, runsDir: opts.runsDir, name: `${c.cnr ?? "case"}-order-${o.number || i + 1}`.replace(/[^\w.-]+/g, "_") });
    if (r.localPath) { o.localPath = r.localPath; saved++; }
    else { failed++; (c.warnings ??= []).push(`order ${o.number || i + 1}: PDF not saved — ${r.error ?? "no run directory"}`); }
  }
  return { saved, failed };
}
