import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseApiKeys, extractKey, keyIsValid, assertSafeToListen, corsOrigin, RateLimiter, validateSearchInput,
} from "../src/core/security.ts";
import { consumeCaptchaCall, captchaBudgetStatus, resetCaptchaBudgetForTests } from "../src/core/budget.ts";

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe("API keys", () => {
  test("parse", () => assert.deepEqual(parseApiKeys(" a , b,,c "), ["a", "b", "c"]));
  test("extract from Bearer or X-API-Key", () => {
    assert.equal(extractKey(h({ authorization: "Bearer k1" })), "k1");
    assert.equal(extractKey(h({ authorization: "bearer  k2 " })), "k2");
    assert.equal(extractKey(h({ "x-api-key": "k3" })), "k3");
    assert.equal(extractKey(h({})), undefined);
  });
  test("validate", () => {
    assert.ok(keyIsValid("k1", ["k0", "k1"]));
    for (const bad of [undefined, "", "k", "k11", "K1"]) assert.equal(keyIsValid(bad, ["k0", "k1"]), false, String(bad));
    assert.equal(keyIsValid("anything", []), false);
  });
  test("refuses a public listen address without keys, allows loopback or keyed", () => {
    assert.throws(() => assertSafeToListen("0.0.0.0", []), /Refusing to listen/);
    assert.doesNotThrow(() => assertSafeToListen("127.0.0.1", []));
    assert.doesNotThrow(() => assertSafeToListen("0.0.0.0", ["k"]));
  });
});

test("CORS only allows listed origins", () => {
  const o = corsOrigin(["https://a.example"]);
  assert.equal(o("https://a.example"), "https://a.example");
  assert.equal(o("https://evil.example"), undefined);
  assert.equal(corsOrigin([])("https://a.example"), undefined);
});

describe("rate limit", () => {
  test("blocks after the limit and reports retry time; resets next window", () => {
    let t = 1_000_000;
    const rl = new RateLimiter(3, 60_000, () => t);
    assert.deepEqual([rl.check("k"), rl.check("k"), rl.check("k")], [0, 0, 0]);
    t += 20_000;
    assert.equal(rl.check("k"), 40);
    assert.equal(rl.check("other"), 0, "keys are independent");
    t += 40_000;
    assert.equal(rl.check("k"), 0);
  });
});

describe("input validation", () => {
  const ok = (b: unknown) => validateSearchInput(b, ["KRHC", "APHC"]);
  test("accepts valid searches", () => {
    assert.ok(ok({ court: "high_court", bench: "KRHC", searchBy: "cnr", cnr: "KAHC010112112026" }).ok);
    assert.ok(ok({ court: "high_court", bench: "APHC", searchBy: "cnr", cnr: "APHC01-059651-2026", tier: "auto" }).ok);
    assert.ok(ok({ court: "high_court", bench: "KRHC", searchBy: "case", caseType: "WP(C)", caseNumber: "5826", year: "2026" }).ok);
    assert.ok(ok({ court: "high_court", bench: "KRHC", searchBy: "filing", filingNumber: "248953", year: "2017" }).ok);
    assert.ok(ok({ court: "district", searchBy: "cnr", cnr: "MHAU010012342020", state: "27", district: "1" }).ok);
  });
  test("trims values", () => {
    const r = ok({ court: "high_court", bench: "KRHC", searchBy: "cnr", cnr: "  KAHC010112112026 " });
    assert.ok(r.ok && r.value.cnr === "KAHC010112112026");
  });
  test("rejects bad input with every reason listed", () => {
    const r = ok({ court: "supreme", searchBy: "x", tier: "gpu", bench: "ZZZZ", cnr: 5 });
    assert.ok(!r.ok);
    if (!r.ok) assert.ok(r.errors.length >= 4, r.errors.join("|"));
  });
  test("rejects injection-looking and oversized values", () => {
    for (const bad of [
      { court: "high_court", searchBy: "cnr", cnr: "KAHC0101121120'; DROP" },
      { court: "high_court", searchBy: "cnr", cnr: "A".repeat(5000) },
      { court: "high_court", searchBy: "case", caseType: "<script>", caseNumber: "1", year: "2026" },
      { court: "high_court", searchBy: "case", caseType: "WP", caseNumber: "12345678", year: "2026" },
      { court: "high_court", searchBy: "case", caseType: "WP", caseNumber: "1", year: "1850" },
      { court: "high_court", searchBy: "filing", filingNumber: "1 or 1=1", year: "2026" },
    ]) assert.equal(ok(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  });
  test("required fields per search type", () => {
    assert.equal(ok({ court: "high_court", searchBy: "cnr" }).ok, false);
    assert.equal(ok({ court: "high_court", searchBy: "case", caseType: "WP" }).ok, false);
    assert.equal(ok({ court: "high_court", searchBy: "filing", year: "2026" }).ok, false);
  });
  test("non-objects are rejected", () => {
    for (const b of [null, [], "x", 5, undefined]) assert.equal(ok(b).ok, false);
  });
});

describe("captcha budget", () => {
  beforeEach(() => { resetCaptchaBudgetForTests(); process.env.CAPTCHA_DAILY_BUDGET = "3"; });
  test("allows up to the budget then refuses", () => {
    const now = new Date("2026-11-21T10:00:00Z");
    consumeCaptchaCall(now); consumeCaptchaCall(now); consumeCaptchaCall(now);
    assert.throws(() => consumeCaptchaCall(now), /captcha budget exhausted: 3\/3/);
    assert.deepEqual(captchaBudgetStatus(now), { day: "2026-11-21", used: 3, budget: 3 });
  });
  test("resets on a new UTC day", () => {
    consumeCaptchaCall(new Date("2026-11-21T23:59:00Z")); consumeCaptchaCall(new Date("2026-11-21T23:59:30Z")); consumeCaptchaCall(new Date("2026-11-21T23:59:40Z"));
    assert.doesNotThrow(() => consumeCaptchaCall(new Date("2026-11-22T00:00:05Z")));
  });
  test("0 means unlimited", () => {
    process.env.CAPTCHA_DAILY_BUDGET = "0";
    for (let i = 0; i < 50; i++) consumeCaptchaCall(new Date("2026-11-21T10:00:00Z"));
  });
});
