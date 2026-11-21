// Spend cap for LLM captcha calls (review item 10: one paid call per attempt, no ceiling).
// CAPTCHA_DAILY_BUDGET = max LLM captcha calls per UTC day (default 2000, 0 = unlimited).
// The counter is in memory: it resets when the server restarts, so treat it as a safety net
// against runaway loops, not as billing-grade accounting.
let day = "";
let used = 0;

const today = (now: Date) => now.toISOString().slice(0, 10);

export function captchaBudget(): number {
  const n = parseInt(process.env.CAPTCHA_DAILY_BUDGET ?? "2000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

// Call before each paid captcha request. Throws when the day's budget is spent.
export function consumeCaptchaCall(now: Date = new Date()): void {
  const d = today(now);
  if (d !== day) { day = d; used = 0; }
  const budget = captchaBudget();
  if (budget > 0 && used >= budget) {
    throw new Error(`captcha budget exhausted: ${used}/${budget} LLM captcha calls used today (CAPTCHA_DAILY_BUDGET)`);
  }
  used++;
}

export function captchaBudgetStatus(now: Date = new Date()) {
  const d = today(now);
  return { day: d, used: d === day ? used : 0, budget: captchaBudget() };
}

export function resetCaptchaBudgetForTests(): void { day = ""; used = 0; }
