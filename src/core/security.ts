import { timingSafeEqual } from "crypto";
import type { SearchInput } from "./types.js";

// ---------- API keys ----------
// API_KEYS="key1,key2". Unset = no auth, which is only allowed while the server listens on loopback
// (see assertSafeToListen). Keys are compared in constant time.
export function parseApiKeys(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((k) => k.trim()).filter(Boolean);
}

export function extractKey(headers: { get(name: string): string | null | undefined }): string | undefined {
  const auth = headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  return (bearer ?? headers.get("x-api-key") ?? undefined)?.trim() || undefined;
}

export function keyIsValid(given: string | undefined, keys: string[]): boolean {
  if (!given) return false;
  const g = Buffer.from(given);
  let ok = false;
  for (const k of keys) {
    const kb = Buffer.from(k);
    if (kb.length === g.length && timingSafeEqual(kb, g)) ok = true; // no early exit: constant-ish time
  }
  return ok;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export function assertSafeToListen(host: string, keys: string[]): void {
  if (!LOOPBACK.has(host) && keys.length === 0) {
    throw new Error(`Refusing to listen on ${host} without API_KEYS set. Set API_KEYS, or use HOST=127.0.0.1.`);
  }
}

// ---------- CORS ----------
// CORS_ORIGINS="https://a.example,https://b.example". Unset = no cross-origin access at all
// (the bundled UI is same-origin, so it needs none).
export function corsOrigin(allowed: string[]): (origin: string) => string | undefined {
  return (origin) => (allowed.includes(origin) ? origin : undefined);
}

// ---------- rate limit (fixed window, in memory) ----------
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private limit: number, private windowMs = 60_000, private now: () => number = Date.now) {}

  // Returns 0 if allowed, otherwise seconds until the window resets.
  check(id: string): number {
    const t = this.now();
    const h = this.hits.get(id);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(id, { windowStart: t, count: 1 });
      if (this.hits.size > 10_000) this.sweep(t);
      return 0;
    }
    if (h.count >= this.limit) return Math.ceil((h.windowStart + this.windowMs - t) / 1000);
    h.count++;
    return 0;
  }
  private sweep(t: number) { for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k); }
}

// ---------- input validation ----------
const HC_BENCH = /^[A-Z]{4}$/;
const COURTS = new Set(["district", "high_court"]);
const SEARCH_BY = new Set(["cnr", "case", "filing"]);
const TIERS = new Set(["auto", "http", "lightpanda", "chromium"]);

export function validateSearchInput(body: unknown, benches?: Iterable<string>): { ok: true; value: SearchInput & { tier?: string } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const b = body as Record<string, unknown>;

  const str = (k: string, re: RegExp, what: string, required = false) => {
    const v = b[k];
    if (v === undefined || v === "") { if (required) errors.push(`${k} is required`); return; }
    if (typeof v !== "string" || !re.test(v.trim())) errors.push(`${k} must be ${what}`);
  };

  if (typeof b.court !== "string" || !COURTS.has(b.court)) errors.push("court must be 'district' or 'high_court'");
  if (typeof b.searchBy !== "string" || !SEARCH_BY.has(b.searchBy)) errors.push("searchBy must be 'cnr', 'case' or 'filing'");
  if (b.tier !== undefined && (typeof b.tier !== "string" || !TIERS.has(b.tier))) errors.push("tier must be auto, http, lightpanda or chromium");

  if (b.bench !== undefined) {
    const known = benches ? new Set(benches) : undefined;
    if (typeof b.bench !== "string" || !HC_BENCH.test(b.bench) || (known && !known.has(b.bench))) errors.push("bench is not a known High Court code");
  }

  // HC CNR: 4 letters + 12 digits (dashes allowed). District CNR: 2 letters + 14 digits.
  str("cnr", /^(?:[A-Za-z]{4}[\d-]{12,16}|[A-Za-z]{2}\d{14})$/, "a CNR such as KAHC010112112026 or APHC01-059651-2026", b.searchBy === "cnr");
  str("caseType", /^[A-Za-z0-9().\/ -]{1,20}$/, "1-20 letters, digits or . ( ) / -", b.searchBy === "case");
  str("caseNumber", /^\d{1,7}$/, "1-7 digits", b.searchBy === "case");
  str("filingNumber", /^\d{1,7}$/, "1-7 digits", b.searchBy === "filing");
  str("year", /^(19|20)\d{2}$/, "a 4-digit year", b.searchBy === "case" || b.searchBy === "filing");
  for (const k of ["state", "district", "complex"]) str(k, /^\d{1,4}$/, "a numeric code");

  if (errors.length) return { ok: false, errors };
  const v = { ...b } as unknown as SearchInput & { tier?: string };
  for (const k of ["cnr", "caseType", "caseNumber", "filingNumber", "year"] as const) {
    if (typeof v[k] === "string") (v as any)[k] = (v[k] as string).trim();
  }
  return { ok: true, value: v };
}
