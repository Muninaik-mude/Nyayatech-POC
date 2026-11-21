import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import * as path from "path";
import * as fs from "fs";

import { SearchInput, ApiResponse, Tier, RunMetrics } from "./core/types.js";
import { newRunId, buildMetrics, appendRunMetrics } from "./core/metrics.js";
import { saveHtml, saveResult, cleanOldRuns, captureFixture } from "./core/snapshot.js";
import { SearchError } from "./core/captcha.js";
import { districtSearch } from "./connectors/district.js";
import { hcServicesSearch, HC_BENCHES, CNR_PREFIX_TO_BENCH } from "./connectors/hcservices.js";
import { fetchWithTier } from "./core/tiers.js";
import { csisApSearch } from "./connectors/csis-ap.js";
import { csisTsSearch } from "./connectors/csis-ts.js";
import { enqueue, getJob, getQueueStats, initQueue } from "./core/queue.js";
import {
  parseApiKeys, extractKey, keyIsValid, assertSafeToListen, corsOrigin, RateLimiter, validateSearchInput,
} from "./core/security.js";
import { captchaBudgetStatus } from "./core/budget.js";
import { TtlCache } from "./core/cache.js";
import { downloadOrderPdfs } from "./core/pdf.js";
import { apCauseList, apCauseListCourts, apCauseListDates, AP_LIST_TYPES, type ApListType } from "./connectors/cause-list-ap.js";

// Captcha counts for a failed search (connectors throw SearchError carrying them), so the
// measured solve rate includes failures instead of only the runs that happened to succeed.
const failCounts = (err: unknown) =>
  err instanceof SearchError
    ? { captchaAttempts: err.captchaAttempts, captchaSolves: err.captchaSolves }
    : { captchaAttempts: 0, captchaSolves: 0 };

// Repeat lookups for the same CNR inside the window cost no captcha and no portal hit (review item 10).
const cnrCache = new TtlCache<Awaited<ReturnType<typeof hcServicesSearch>>>((parseInt(process.env.CNR_CACHE_MINUTES ?? "15", 10) || 15) * 60_000);
const causeListCache = new TtlCache<unknown>(10 * 60_000);

const app = new Hono();
const PORT = parseInt(process.env.PORT ?? "3000");
const RUNS_DIR = path.resolve(process.env.RUNS_DIR ?? "./runs");

// ---- security (review item 9) ----
const API_KEYS = parseApiKeys(process.env.API_KEYS);
const HOST = process.env.HOST ?? "127.0.0.1"; // loopback unless you opt in (then API_KEYS is mandatory)
const searchLimiter = new RateLimiter(parseInt(process.env.RATE_LIMIT_PER_MIN ?? "30", 10) || 30);

// CORS: closed by default. The bundled UI is same-origin and needs none.
app.use("*", cors({ origin: corsOrigin(parseApiKeys(process.env.CORS_ORIGINS)) }));
app.use("/public/*", serveStatic({ root: "./" }));

// Every /api route needs a key when API_KEYS is set.
app.use("/api/*", async (c, next) => {
  if (API_KEYS.length && !keyIsValid(extractKey(c.req.raw.headers), API_KEYS)) {
    return c.json({ error: "unauthorized: send 'Authorization: Bearer <key>' or 'X-API-Key'" }, 401);
  }
  await next();
});

// Per-key rate limit for routes that cost a captcha solve.
const rateLimited: MiddlewareHandler = async (c, next) => {
  const wait = searchLimiter.check(extractKey(c.req.raw.headers) ?? "local");
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    return c.json({ error: `rate limit exceeded — retry in ${wait}s` }, 429);
  }
  await next();
};

// Parse + validate a search body (size-capped). Returns a Response on failure.
async function readSearchBody(c: Context, defaults: Record<string, unknown> = {}) {
  if (Number(c.req.header("content-length") ?? 0) > 10_000) return { error: c.json({ error: "body too large" }, 413) };
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return { error: c.json({ error: "body must be valid JSON" }, 400) }; }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) raw = { ...defaults, ...(raw as object) };
  const v = validateSearchInput(raw, Object.keys(HC_BENCHES));
  if (!v.ok) return { error: c.json({ error: "invalid input", details: v.errors }, 400) };
  return { body: v.value as SearchInput & { tier?: string; quickRunId?: string } };
}

// Debug routes fetch arbitrary URLs: off unless ENABLE_DEBUG=1, and limited to *.gov.in hosts.
const debugOnly: MiddlewareHandler = async (c, next) => {
  if (process.env.ENABLE_DEBUG !== "1") return c.json({ error: "not found" }, 404);
  const target = c.req.query("url");
  if (target) {
    let host = "";
    try { host = new URL(target).hostname; } catch { return c.json({ error: "invalid url" }, 400); }
    if (!/(^|\.)gov\.in$/i.test(host)) return c.json({ error: "only *.gov.in hosts are allowed" }, 400);
  }
  await next();
};
app.use("/api/debug/*", debugOnly);

// Serve the single-page UI
app.get("/", async (c) => {
  const html = await fs.promises.readFile(path.resolve("public/index.html"), "utf8");
  return c.html(html);
});

// Reference data endpoints
app.get("/api/reference/benches", (c) => {
  return c.json(HC_BENCHES);
});
app.get("/api/reference/cnr-prefix-map", (c) => {
  return c.json(CNR_PREFIX_TO_BENCH);
});

// Sample CNRs per High Court (from data/high-court-cnrs.json)
app.get("/api/reference/sample-cnrs", async (c) => {
  const raw = await fs.promises.readFile(path.resolve("data/high-court-cnrs.json"), "utf8");
  return c.json(JSON.parse(raw));
});

// Debug: fetch a URL through any tier — saves full HTML to runs/debug_*.html
app.get("/api/debug/fetch", async (c) => {
  const url = c.req.query("url");
  const tier = (c.req.query("tier") ?? undefined) as Tier | undefined;
  if (!url) return c.json({ error: "?url= required" }, 400);
  try {
    const result = await fetchWithTier({ url }, () => true, tier);
    const fname = `debug_${Date.now()}.html`;
    const fpath = path.join(RUNS_DIR, fname);
    await fs.promises.mkdir(RUNS_DIR, { recursive: true });
    await fs.promises.writeFile(fpath, result.html, "utf8");
    return c.json({
      tier: result.tier,
      htmlLength: result.html.length,
      bytes: result.bytes,
      durationMs: result.durationMs,
      savedTo: fpath,
      preview: result.html.slice(0, 2000),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Debug: screenshot + full rendered HTML via Playwright
app.get("/api/debug/screenshot", async (c) => {
  const url = c.req.query("url") ?? "https://hcservices.ecourts.gov.in/ecourtindiaHC/";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000); // extra 3s for AJAX to settle
    await fs.promises.mkdir(RUNS_DIR, { recursive: true });
    const imgPath = path.join(RUNS_DIR, `screenshot_${Date.now()}.png`);
    const htmlPath = path.join(RUNS_DIR, `rendered_${Date.now()}.html`);
    await page.screenshot({ path: imgPath, fullPage: true });
    const html = await page.content();
    await fs.promises.writeFile(htmlPath, html, "utf8");
    return c.json({ screenshotSaved: imgPath, htmlSaved: htmlPath, htmlLength: html.length, preview: html.slice(0, 2000) });
  } finally {
    await context.close();
    await browser.close();
  }
});

// Queue status
// ---- AP High Court cause list (public, no captcha) ----
const isoToDdMm = (iso: string) => iso.split("-").reverse().join("-");
const clType = (v: string | undefined): ApListType | undefined => (v && v in AP_LIST_TYPES ? (v as ApListType) : undefined);
const clDate = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? isoToDdMm(v) : undefined);

app.get("/api/cause-list/ap/dates", rateLimited, async (c) => {
  const type = clType(c.req.query("type") ?? "D");
  if (!type) return c.json({ error: `type must be one of ${Object.keys(AP_LIST_TYPES).join(", ")}` }, 400);
  try {
    const { value } = await causeListCache.wrap(`dates:${type}`, () => apCauseListDates(type));
    return c.json({ type, dates: value });
  } catch (err) { return c.json({ error: (err as Error).message }, 502); }
});

app.get("/api/cause-list/ap/courts", rateLimited, async (c) => {
  const type = clType(c.req.query("type") ?? "D"), date = clDate(c.req.query("date"));
  if (!type || !date) return c.json({ error: "type (D/A/W/S/P/F) and date (YYYY-MM-DD) are required" }, 400);
  try {
    const { value } = await causeListCache.wrap(`courts:${type}:${date}`, () => apCauseListCourts(type, date));
    return c.json({ type, date: c.req.query("date"), courts: value });
  } catch (err) { return c.json({ error: (err as Error).message }, 502); }
});

app.get("/api/cause-list/ap", rateLimited, async (c) => {
  const type = clType(c.req.query("type") ?? "D"), date = clDate(c.req.query("date")), court = c.req.query("court") ?? "";
  if (!type || !date || !/^\d{1,4}$/.test(court)) return c.json({ error: "type, date (YYYY-MM-DD) and court (numeric code, see /courts) are required" }, 400);
  try {
    const { value, cached } = await causeListCache.wrap(`list:${type}:${date}:${court}`, () => apCauseList(type, date, court));
    return c.json({ cached, causeList: value });
  } catch (err) { return c.json({ error: (err as Error).message }, 502); }
});

app.get("/api/captcha/budget", (c) => c.json(captchaBudgetStatus()));
app.get("/api/queue/stats", (c) => {
  return c.json(getQueueStats());
});

// Poll job result
app.get("/api/job/:jobId", (c) => {
  const job = getJob(c.req.param("jobId"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// Async CNR search — submit and get jobId back immediately
app.post("/api/search/cnr", rateLimited, async (c) => {
  const parsed = await readSearchBody(c, { court: "high_court", searchBy: "cnr" });
  if (parsed.error) return parsed.error;
  const body = parsed.body!;

  const forceTier = (body.tier === "auto" || !body.tier) ? undefined : body.tier as Tier;

  const { jobId } = enqueue(async () => {
    const runId = newRunId();
    const start = Date.now();

    let result, cached = false;
    try {
      const key = `${(body.bench ?? "").toUpperCase()}:${(body.cnr ?? "").toUpperCase().replace(/-/g, "")}`;
      ({ value: result, cached } = await cnrCache.wrap(key, () => hcServicesSearch({ ...body, searchBy: "cnr" }, forceTier)));
    } catch (err) {
      await appendRunMetrics(buildMetrics({
        runId, portal: "hcservices.ecourts.gov.in", tier: forceTier ?? "http",
        durationMs: Date.now() - start, responseBytes: 0, ...failCounts(err),
        captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
        steps: [], tierEscalations: [], ok: false, error: (err as Error).message,
      }), RUNS_DIR);
      throw err; // the queue records the job as failed
    }
    const metrics = buildMetrics({
      runId,
      portal: "hcservices.ecourts.gov.in",
      tier: result.tier,
      durationMs: Date.now() - start,
      responseBytes: result.bytes,
      captchaAttempts: result.captchaAttempts,
      captchaSolves: result.captchaSolves,
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: result.escalations,
      ok: true,
    });

    let pdfs = { saved: 0, failed: 0 };
    if (!cached && process.env.DOWNLOAD_ORDERS !== "0") pdfs = await downloadOrderPdfs(result.caseResult, { runId, runsDir: RUNS_DIR });
    await saveResult(runId, result.caseResult, RUNS_DIR);
    if (!cached) await captureFixture(result.caseResult.dataSource, result.caseResult.cnr ?? runId, result.rawHtml);
    await appendRunMetrics(metrics, RUNS_DIR);

    return {
      runId, ok: true, tier: result.tier, cached, orderPdfs: pdfs,
      case: result.caseResult,
      hearings: result.caseResult.hearings,
      documents: result.caseResult.documents,
      metrics,
    };
  });

  const job = getJob(jobId)!;
  return c.json({ jobId, status: job.status, position: job.position }, 202);
});

// Quick search: district or hcservices
app.post("/api/quick", rateLimited, async (c) => {
  const parsed = await readSearchBody(c);
  if (parsed.error) return parsed.error;
  const body = parsed.body!;
  const runId = newRunId();
  const start = Date.now();
  const forceTier = (body.tier === "auto" || !body.tier) ? undefined : body.tier as Tier;

  try {
    let result;
    if (body.court === "district") {
      result = await districtSearch(body, forceTier);
    } else {
      result = await hcServicesSearch(body, forceTier);
    }
    const metrics = buildMetrics({
      runId,
      portal: body.court === "district" ? "services.ecourts.gov.in" : "hcservices.ecourts.gov.in",
      tier: result.tier,
      durationMs: Date.now() - start,
      responseBytes: result.bytes,
      captchaAttempts: result.captchaAttempts,
      captchaSolves: result.captchaSolves,
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: result.escalations,
      ok: true,
    });

    await saveResult(runId, result.caseResult, RUNS_DIR);
    await captureFixture(result.caseResult.dataSource, result.caseResult.cnr ?? runId, result.rawHtml);
    await appendRunMetrics(metrics, RUNS_DIR);

    const response: ApiResponse = {
      runId,
      ok: true,
      tier: result.tier,
      case: result.caseResult,
      hearings: result.caseResult.hearings,
      documents: result.caseResult.documents,
      fieldsOnlyInDeep: [],
      metrics,
    };

    return c.json(response);
  } catch (err) {
    const error = (err as Error).message;
    const metrics = buildMetrics({
      runId,
      portal: body.court === "district" ? "services.ecourts.gov.in" : "hcservices.ecourts.gov.in",
      tier: forceTier ?? "http",
      durationMs: Date.now() - start,
      responseBytes: 0,
      ...failCounts(err),
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: [],
      ok: false,
      error,
    });
    await appendRunMetrics(metrics, RUNS_DIR);
    return c.json({ runId, ok: false, error, metrics } as ApiResponse, 500);
  }
});

// Deep search: AP HC or TS HC
app.post("/api/deep", rateLimited, async (c) => {
  const parsed = await readSearchBody(c);
  if (parsed.error) return parsed.error;
  const body = parsed.body!;
  const runId = newRunId();
  const start = Date.now();
  const forceTier = (body.tier === "auto" || !body.tier) ? undefined : body.tier as Tier;

  const bench = body.bench ?? "";

  // Check if we have a dedicated deep adapter; otherwise fall back to hcServicesSearch
  const hasDeepAdapter = bench === "APHC" || bench === "TSHC" || body.court === "district";
  if (!hasDeepAdapter && body.court === "high_court") {
    // No dedicated deep adapter — run the same search as Quick and return it
    try {
      const result = await hcServicesSearch(body, forceTier);
      const metrics = buildMetrics({
        runId,
        portal: "hcservices.ecourts.gov.in",
        tier: result.tier,
        durationMs: Date.now() - start,
        responseBytes: result.bytes,
        captchaAttempts: result.captchaAttempts,
        captchaSolves: result.captchaSolves,
        captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
        steps: [],
        tierEscalations: result.escalations,
        ok: true,
      });
      await saveResult(runId, result.caseResult, RUNS_DIR);
    await captureFixture(result.caseResult.dataSource, result.caseResult.cnr ?? runId, result.rawHtml);
      await appendRunMetrics(metrics, RUNS_DIR);
      return c.json({
        runId, ok: true, tier: result.tier,
        case: result.caseResult,
        hearings: result.caseResult.hearings,
        documents: result.caseResult.documents,
        fieldsOnlyInDeep: [],
        metrics,
      } as ApiResponse);
    } catch (err) {
      const error = (err as Error).message;
      const metrics = buildMetrics({
        runId, portal: bench, tier: forceTier ?? "http",
        durationMs: Date.now() - start, responseBytes: 0,
        ...failCounts(err),
        captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
        steps: [], tierEscalations: [], ok: false, error,
      });
      await appendRunMetrics(metrics, RUNS_DIR);
      return c.json({ runId, ok: false, error, metrics } as ApiResponse, 500);
    }
  }

  if (!hasDeepAdapter) {
    return c.json(
      {
        runId,
        ok: false,
        error: `Deep search not available for bench: ${bench || body.court}`,
        tier: "http" as Tier,
        metrics: buildMetrics({
          runId, portal: bench, tier: "http",
          durationMs: 0, responseBytes: 0,
          captchaAttempts: 0, captchaSolves: 0,
          captchaProvider: "claude",
          steps: [], tierEscalations: [],
          ok: false, error: "no deep adapter",
        }),
      } as ApiResponse,
      404
    );
  }

  try {
    let result;
    if (bench === "APHC") {
      result = await csisApSearch(body, undefined, runId, RUNS_DIR, forceTier);
    } else if (bench === "TSHC") {
      result = await csisTsSearch(body, undefined, runId, RUNS_DIR, forceTier);
    } else {
      throw new Error("No deep adapter for this court");
    }
    const metrics = buildMetrics({
      runId,
      portal: bench === "APHC" ? "digi-courts.aphc.ap.gov.in" : "csis.tshc.gov.in",
      tier: result.tier,
      durationMs: Date.now() - start,
      responseBytes: result.bytes,
      captchaAttempts: result.captchaAttempts,
      captchaSolves: result.captchaSolves,
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: result.escalations,
      ok: true,
    });

    await saveResult(runId, result.caseResult, RUNS_DIR);
    await captureFixture(result.caseResult.dataSource, result.caseResult.cnr ?? runId, result.rawHtml);
    await appendRunMetrics(metrics, RUNS_DIR);

    const response: ApiResponse = {
      runId,
      ok: true,
      tier: result.tier,
      case: result.caseResult,
      hearings: result.caseResult.hearings,
      documents: result.caseResult.documents,
      fieldsOnlyInDeep: result.fieldsOnlyInDeep,
      metrics,
    };

    return c.json(response);
  } catch (err) {
    const error = (err as Error).message;
    const metrics = buildMetrics({
      runId,
      portal: bench,
      tier: forceTier ?? "http",
      durationMs: Date.now() - start,
      responseBytes: 0,
      ...failCounts(err),
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: [],
      ok: false,
      error,
    });
    await appendRunMetrics(metrics, RUNS_DIR);
    return c.json({ runId, ok: false, error, metrics } as ApiResponse, 500);
  }
});

assertSafeToListen(HOST, API_KEYS);
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, async () => {
  console.log(`Courts POC running at http://${HOST}:${PORT}`);
  console.log(`Auth: ${API_KEYS.length ? `${API_KEYS.length} API key(s) required on /api/*` : "off (loopback only)"} · rate limit ${process.env.RATE_LIMIT_PER_MIN ?? 30}/min · captcha budget ${captchaBudgetStatus().budget}/day`);
  console.log(`Runs dir: ${RUNS_DIR}`);
  console.log(`Captcha provider: ${process.env.CAPTCHA_PROVIDER ?? "claude"}`);
  console.log(`Default tier: ${process.env.DEFAULT_TIER ?? "auto"}`);

  const q = initQueue(path.join(RUNS_DIR, "jobs"));
  if (q.restored) console.log(`Queue: restored ${q.restored} job records (${q.interrupted} interrupted by the restart)`);

  // Clean up run folders older than 7 days on every startup
  const deleted = await cleanOldRuns(RUNS_DIR, 7);
  if (deleted > 0) console.log(`Cleaned up ${deleted} old run folders (>7 days)`);
});
