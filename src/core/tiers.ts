import { Tier, TierResult } from "./types.js";
import { fetch as undiciFetch } from "undici";
import { chromium } from "playwright";
import { createConnection } from "net";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Fetch a binary resource (captcha image, PDF) and return raw bytes + detected media type
export async function fetchImageBytes(
  url: string,
  cookieJar?: Map<string, string>
): Promise<{ bytes: Buffer; mediaType: "image/png" | "image/jpeg" | "image/gif" }> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "image/png,image/jpeg,image/*,*/*",
  };
  if (cookieJar && cookieJar.size > 0) {
    headers["Cookie"] = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const res = await undiciFetch(url, { headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") ?? "";
  const mediaType = ct.includes("jpeg") || ct.includes("jpg") ? "image/jpeg"
    : ct.includes("gif") ? "image/gif"
    : "image/png";
  return { bytes, mediaType };
}

export interface FetchOptions {
  url: string;
  method?: "GET" | "POST";
  body?: Record<string, string> | string;
  headers?: Record<string, string>;
  tier?: Tier;
  cookieJar?: Map<string, string>; // shared jar — HTTP tier reads & writes cookies here
}

export interface TierFetcher {
  fetch(opts: FetchOptions): Promise<TierResult>;
  close(): Promise<void>;
}

// T0: Plain HTTP via undici — with cookie jar support for session-based portals
class HttpTier implements TierFetcher {
  async fetch(opts: FetchOptions): Promise<TierResult> {
    const start = Date.now();
    // Full browser-like headers — WAF on ecourts portals blocks requests missing Sec-Fetch-* headers
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "max-age=0",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Sec-Ch-Ua": '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      ...opts.headers,
    };

    // Apply cookies from jar into request
    if (opts.cookieJar && opts.cookieJar.size > 0) {
      headers["Cookie"] = [...opts.cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    let body: string | undefined;
    if (opts.method === "POST" && opts.body) {
      if (typeof opts.body === "string") {
        body = opts.body;
      } else {
        body = new URLSearchParams(opts.body).toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
      // POST comes from within the site, so update Sec-Fetch headers accordingly
      headers["Sec-Fetch-Site"] = "same-origin";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-User"] = "?1";
      headers["Origin"] = new URL(opts.url).origin;
    }

    const res = await undiciFetch(opts.url, {
      method: opts.method ?? "GET",
      headers,
      body,
    });

    // Capture Set-Cookie back into the jar
    if (opts.cookieJar) {
      const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
      for (const raw of setCookies) {
        const eq = raw.indexOf("=");
        const semi = raw.indexOf(";");
        if (eq > 0) {
          const name = raw.slice(0, eq).trim();
          const value = (semi > eq ? raw.slice(eq + 1, semi) : raw.slice(eq + 1)).trim();
          opts.cookieJar.set(name, value);
        }
      }
    }

    const html = await res.text();
    console.log(`[http] status=${res.status} finalUrl=${res.url} ct=${res.headers.get("content-type")} htmlLen=${html.length}`);
    return {
      html,
      tier: "http",
      durationMs: Date.now() - start,
      bytes: Buffer.byteLength(html),
    };
  }

  async close(): Promise<void> {}
}

// T1: Lightpanda via CDP
class LightpandaTier implements TierFetcher {
  private browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;

  private async getBrowser() {
    if (!this.browser) {
      const url = process.env.LIGHTPANDA_URL ?? "ws://127.0.0.1:9222";
      // Short timeout so a missing Lightpanda process fails fast and escalates to T2
      this.browser = await chromium.connectOverCDP(url, { timeout: 4000 });
    }
    return this.browser;
  }

  async fetch(opts: FetchOptions): Promise<TierResult> {
    const start = Date.now();
    let browser;
    try {
      browser = await this.getBrowser();
    } catch (err) {
      this.browser = null; // reset so next attempt retries the connect
      throw err;
    }
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      if (opts.method === "POST" && opts.body) {
        await page.route(opts.url, (route) => {
          route.continue({
            method: "POST",
            postData: typeof opts.body === "string" ? opts.body : new URLSearchParams(opts.body as Record<string, string>).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded", ...opts.headers },
          });
        });
      }
      await page.goto(opts.url, { waitUntil: "networkidle", timeout: 30000 });
      const html = await page.content();
      return { html, tier: "lightpanda", durationMs: Date.now() - start, bytes: Buffer.byteLength(html) };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

// T2: Playwright + Chromium
class ChromiumTier implements TierFetcher {
  private browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  private async getBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  async fetch(opts: FetchOptions): Promise<TierResult> {
    const start = Date.now();
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    try {
      if (opts.method === "POST" && opts.body) {
        await page.route(opts.url, (route) => {
          route.continue({
            method: "POST",
            postData: typeof opts.body === "string" ? opts.body : new URLSearchParams(opts.body as Record<string, string>).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded", ...opts.headers },
          });
        });
      }
      await page.goto(opts.url, { waitUntil: "networkidle", timeout: 30000 });
      const html = await page.content();
      return { html, tier: "chromium", durationMs: Date.now() - start, bytes: Buffer.byteLength(html) };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const httpTier = new HttpTier();
export const lightpandaTier = new LightpandaTier();
export const chromiumTier = new ChromiumTier();

// Quick TCP port probe — resolves in ≤500ms
async function isTcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    sock.setTimeout(500);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error",   () => { sock.destroy(); resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

let _lightpandaKnownDown = false; // cache within process lifetime

export type TierEscalation = { from: Tier; to: Tier; reason: string };

export interface FetchWithTierResult extends TierResult {
  escalations: TierEscalation[];
}

// Try tiers in order: T0 HTTP -> T1 Lightpanda -> T2 Chromium
// Returns first successful result with escalation log
export async function fetchWithTier(
  opts: FetchOptions,
  validate: (html: string) => boolean = () => true,
  forceTier?: Tier
): Promise<FetchWithTierResult> {
  const defaultTier = (process.env.DEFAULT_TIER ?? "auto") as Tier | "auto";
  const escalations: TierEscalation[] = [];

  let tierOrder: { tier: Tier; fetcher: TierFetcher }[];

  if (forceTier) {
    tierOrder = [{ tier: forceTier, fetcher: getTierFetcher(forceTier) }];
  } else if (defaultTier !== "auto") {
    tierOrder = [{ tier: defaultTier as Tier, fetcher: getTierFetcher(defaultTier as Tier) }];
  } else {
    // Auto: check Lightpanda availability once and skip it if not running
    if (!_lightpandaKnownDown) {
      const lpUrl = new URL(process.env.LIGHTPANDA_URL ?? "ws://127.0.0.1:9222");
      const port = parseInt(lpUrl.port) || 9222;
      const up = await isTcpOpen(lpUrl.hostname, port);
      if (!up) _lightpandaKnownDown = true;
    }
    tierOrder = [
      { tier: "http", fetcher: httpTier },
      ...(_lightpandaKnownDown ? [] : [{ tier: "lightpanda" as Tier, fetcher: lightpandaTier as TierFetcher }]),
      { tier: "chromium", fetcher: chromiumTier },
    ];
  }

  let lastError: Error | null = null;
  const triedLog: string[] = [];

  for (let i = 0; i < tierOrder.length; i++) {
    const { tier, fetcher } = tierOrder[i];
    try {
      const result = await fetcher.fetch(opts);
      const valid = validate(result.html);
      console.log(`[tier:${tier}] ${opts.url} → ${result.bytes}B html=${result.html.length}chars valid=${valid} (${result.durationMs}ms)`);
      if (result.html.length < 500) {
        console.log(`[tier:${tier}] SHORT RESPONSE: ${result.html.slice(0, 300).replace(/\s+/g, " ")}`);
      }
      triedLog.push(`${tier}:${result.html.length}B:${valid ? "ok" : "invalid"}`);
      if (valid) {
        return { ...result, escalations };
      }
      const nextTier = tierOrder[i + 1];
      if (nextTier) {
        escalations.push({ from: tier, to: nextTier.tier, reason: `validation failed (html=${result.html.length}B)` });
      }
    } catch (err) {
      lastError = err as Error;
      const msg = (err as Error).message.split("\n")[0]; // first line only
      console.log(`[tier:${tier}] ${opts.url} → ERROR: ${msg}`);
      triedLog.push(`${tier}:error:${msg.slice(0, 60)}`);
      const nextTier = tierOrder[i + 1];
      if (nextTier) {
        escalations.push({ from: tier, to: nextTier.tier, reason: msg });
      }
    }
  }

  throw lastError ?? new Error(`All tiers exhausted [${triedLog.join(" → ")}]`);
}

function getTierFetcher(tier: Tier): TierFetcher {
  if (tier === "http") return httpTier;
  if (tier === "lightpanda") return lightpandaTier;
  return chromiumTier;
}
