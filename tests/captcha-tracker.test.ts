import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptchaTracker, SearchError } from "../src/core/captcha.ts";
import { withCaptchaRetries } from "../src/core/captcha-loop.ts";

// Simulates what solve() does without calling an LLM.
const fakeSolve = (t: CaptchaTracker) =>
  t.attempts.push({ provider: "claude", mode: "text", imageBytes: 1, answer: "x", accepted: false, durationMs: 1 });

test("trackers are independent — concurrent runs cannot see each other (was a module-level global)", async () => {
  const run = async (id: string, fail: number) => {
    const tracker = new CaptchaTracker();
    let n = 0;
    await withCaptchaRetries({
      tracker, maxAttempts: 10, label: id,
      attempt: async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5)); // interleave runs
        fakeSolve(tracker);
        if (n++ < fail) throw new Error("Invalid Captcha");
      },
    });
    return { attempts: tracker.total, solves: tracker.accepted };
  };
  const results = await Promise.all([run("a", 0), run("b", 2), run("c", 4), run("d", 1), run("e", 3)]);
  assert.deepEqual(results, [
    { attempts: 1, solves: 1 }, { attempts: 3, solves: 1 }, { attempts: 5, solves: 1 },
    { attempts: 2, solves: 1 }, { attempts: 4, solves: 1 },
  ]);
});

test("solves can never exceed attempts (production metrics showed 759 solves for 145 attempts)", async () => {
  for (let i = 0; i < 20; i++) {
    const tracker = new CaptchaTracker();
    await withCaptchaRetries({ tracker, maxAttempts: 3, label: "x", attempt: async () => { fakeSolve(tracker); } });
    assert.ok(tracker.accepted <= tracker.total);
  }
});

test("accepted is set only when the attempt resolves, not when a request merely did not throw", async () => {
  const tracker = new CaptchaTracker();
  await assert.rejects(
    withCaptchaRetries({ tracker, maxAttempts: 3, label: "HC", attempt: async () => { fakeSolve(tracker); throw new Error("portal replied: Invalid Captcha"); } }),
    (e: unknown) => e instanceof SearchError && e.captchaAttempts === 3 && e.captchaSolves === 0 && /Invalid Captcha/.test(e.message),
  );
  assert.equal(tracker.accepted, 0);
  assert.ok(tracker.attempts.every((a) => a.accepted === false));
});

test("a failed search still reports its attempts (so the solve rate is not biased to successes)", async () => {
  const tracker = new CaptchaTracker();
  try {
    await withCaptchaRetries({ tracker, maxAttempts: 5, label: "x", attempt: async () => { fakeSolve(tracker); throw new Error("nope"); } });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof SearchError);
    assert.equal(e.captchaAttempts, 5);
    assert.equal(e.captchaSolves, 0);
  }
});

test("a hard SearchError stops immediately and keeps the counts", async () => {
  const tracker = new CaptchaTracker();
  let calls = 0;
  await assert.rejects(
    withCaptchaRetries({ tracker, maxAttempts: 5, label: "x", attempt: async () => { calls++; fakeSolve(tracker); throw new SearchError("layout changed"); } }),
    (e: unknown) => e instanceof SearchError && e.captchaAttempts === 1 && e.message === "layout changed",
  );
  assert.equal(calls, 1);
});

test("an attempt that fails before reaching the captcha does not mark an earlier attempt", async () => {
  const tracker = new CaptchaTracker();
  let n = 0;
  await withCaptchaRetries({
    tracker, maxAttempts: 3, label: "x",
    attempt: async () => {
      if (n++ === 0) { fakeSolve(tracker); throw new Error("rejected"); }
      if (n === 2) throw new Error("captcha image fetch failed"); // no solve this time
      fakeSolve(tracker);
    },
  });
  assert.deepEqual(tracker.attempts.map((a) => a.accepted), [false, true]);
});

test("locally solved attempts are tracked without an LLM call", () => {
  const t = new CaptchaTracker();
  t.recordLocal("8", "math");
  t.markLast(true);
  assert.deepEqual([t.total, t.accepted, t.attempts[0].provider, t.attempts[0].imageBytes], [1, 1, "local", 0]);
});
