import { CaptchaTracker, SearchError } from "./captcha.js";

// Runs one search attempt per captcha try. `attempt` must fetch a fresh captcha, solve it,
// submit, and THROW if the portal rejects it (validators must be strict — see isCaseDetailPage etc).
//
// "Accepted" is recorded only when `attempt` resolves, i.e. the portal's response passed
// validation — not merely because the HTTP request did not throw.
// On exhaustion a SearchError carries the captcha counts so failed runs still show their solve rate.
export async function withCaptchaRetries<T>(opts: {
  tracker: CaptchaTracker;
  maxAttempts: number;
  label: string;
  delayMs?: number;
  attempt: (n: number) => Promise<T>;
}): Promise<T> {
  const { tracker, maxAttempts, label, delayMs = 0, attempt } = opts;
  let lastError = "";
  for (let n = 0; n < maxAttempts; n++) {
    if (n > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const before = tracker.total;
    try {
      const result = await attempt(n);
      if (tracker.total > before) tracker.markLast(true);
      return result;
    } catch (err) {
      lastError = (err as Error).message.split("\n")[0];
      if (tracker.total > before) tracker.markLast(false);
      // A SearchError is a hard failure (not a captcha miss): stop, but keep the counts.
      if (err instanceof SearchError) throw new SearchError(err.message, tracker.total, tracker.accepted);
    }
  }
  throw new SearchError(
    `${label}: captcha not solved after ${maxAttempts} attempts${lastError ? ` (last: ${lastError})` : ""}`,
    tracker.total,
    tracker.accepted
  );
}
