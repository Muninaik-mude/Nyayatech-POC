import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as path from "path";
import * as fs from "fs";

import { SearchInput, ApiResponse, Tier, RunMetrics } from "./core/types.js";
import { newRunId, buildMetrics, appendRunMetrics } from "./core/metrics.js";
import { saveHtml, saveResult, cleanOldRuns } from "./core/snapshot.js";
import { getCaptchaAttempts } from "./core/captcha.js";
import { districtSearch } from "./connectors/district.js";
import { hcServicesSearch, HC_BENCHES, CNR_PREFIX_TO_BENCH } from "./connectors/hcservices.js";
import { fetchWithTier } from "./core/tiers.js";
import { csisApSearch } from "./connectors/csis-ap.js";
import { csisTsSearch } from "./connectors/csis-ts.js";
import { enqueue, getJob, getQueueStats } from "./core/queue.js";

const app = new Hono();
const PORT = parseInt(process.env.PORT ?? "3000");
const RUNS_DIR = path.resolve(process.env.RUNS_DIR ?? "./runs");

app.use("*", cors());
app.use("/public/*", serveStatic({ root: "./" }));

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
app.post("/api/search/cnr", async (c) => {
  const body = await c.req.json<SearchInput & { tier?: string }>();
  if (!body.cnr) return c.json({ error: "cnr is required" }, 400);

  const forceTier = (body.tier === "auto" || !body.tier) ? undefined : body.tier as Tier;

  const { jobId } = enqueue(async () => {
    const runId = newRunId();
    const start = Date.now();

    const result = await hcServicesSearch({ ...body, searchBy: "cnr" }, forceTier);

    const captchaAttempts = getCaptchaAttempts();
    const metrics = buildMetrics({
      runId,
      portal: "hcservices.ecourts.gov.in",
      tier: result.tier,
      durationMs: Date.now() - start,
      responseBytes: result.bytes,
      captchaAttempts: result.captchaAttempts,
      captchaSolves: captchaAttempts.filter((a) => a.accepted).length,
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: result.escalations,
      ok: true,
    });

    await saveResult(runId, result.caseResult, RUNS_DIR);
    await appendRunMetrics(metrics, RUNS_DIR);

    return {
      runId, ok: true, tier: result.tier,
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
app.post("/api/quick", async (c) => {
  const body = await c.req.json<SearchInput & { tier?: string }>();
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

    const captchaAttempts = getCaptchaAttempts();
    const metrics = buildMetrics({
      runId,
      portal: body.court === "district" ? "services.ecourts.gov.in" : "hcservices.ecourts.gov.in",
      tier: result.tier,
      durationMs: Date.now() - start,
      responseBytes: result.bytes,
      captchaAttempts: result.captchaAttempts,
      captchaSolves: captchaAttempts.filter((a) => a.accepted).length,
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: result.escalations,
      ok: true,
    });

    await saveResult(runId, result.caseResult, RUNS_DIR);
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
      captchaAttempts: 0,
      captchaSolves: 0,
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
app.post("/api/deep", async (c) => {
  const body = await c.req.json<SearchInput & { tier?: string; quickRunId?: string }>();
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
      const captchaAttempts = getCaptchaAttempts();
      const metrics = buildMetrics({
        runId,
        portal: "hcservices.ecourts.gov.in",
        tier: result.tier,
        durationMs: Date.now() - start,
        responseBytes: result.bytes,
        captchaAttempts: result.captchaAttempts,
        captchaSolves: captchaAttempts.filter((a) => a.accepted).length,
        captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
        steps: [],
        tierEscalations: result.escalations,
        ok: true,
      });
      await saveResult(runId, result.caseResult, RUNS_DIR);
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
        captchaAttempts: 0, captchaSolves: 0,
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

    const captchaAttempts = getCaptchaAttempts();
    const metrics = buildMetrics({
      runId,
      portal: bench === "APHC" ? "digi-courts.aphc.ap.gov.in" : "csis.tshc.gov.in",
      tier: result.tier,
      durationMs: Date.now() - start,
      responseBytes: result.bytes,
      captchaAttempts: result.captchaAttempts,
      captchaSolves: captchaAttempts.filter((a) => a.accepted).length,
      captchaProvider: (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini",
      steps: [],
      tierEscalations: result.escalations,
      ok: true,
    });

    await saveResult(runId, result.caseResult, RUNS_DIR);
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
      captchaAttempts: 0,
      captchaSolves: 0,
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

serve({ fetch: app.fetch, port: PORT }, async () => {
  console.log(`Courts POC running at http://localhost:${PORT}`);
  console.log(`Runs dir: ${RUNS_DIR}`);
  console.log(`Captcha provider: ${process.env.CAPTCHA_PROVIDER ?? "claude"}`);
  console.log(`Default tier: ${process.env.DEFAULT_TIER ?? "auto"}`);

  // Clean up run folders older than 7 days on every startup
  const deleted = await cleanOldRuns(RUNS_DIR, 7);
  if (deleted > 0) console.log(`Cleaned up ${deleted} old run folders (>7 days)`);
});
