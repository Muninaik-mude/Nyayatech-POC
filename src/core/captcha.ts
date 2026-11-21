import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { consumeCaptchaCall } from "./budget.js";

// text = read the characters; math = read AND solve; expression = transcribe an arithmetic expression only
// (the caller evaluates it locally with solveMathCaptcha — more reliable than LLM arithmetic).
export type CaptchaMode = "text" | "math" | "expression";

export interface CaptchaAttempt {
  provider: "claude" | "gemini" | "local";
  mode: CaptchaMode;
  imageBytes: number;
  answer: string;
  accepted: boolean;
  durationMs: number;
}

// Per-run captcha bookkeeping. One tracker is created per search and passed down to
// solve(); nothing is stored at module level, so concurrent jobs cannot see each
// other's attempts and nothing accumulates for the life of the process.
export class CaptchaTracker {
  readonly attempts: CaptchaAttempt[] = [];

  get total(): number { return this.attempts.length; }
  get accepted(): number { return this.attempts.filter((a) => a.accepted).length; }

  // Mark the most recent attempt as accepted/rejected by the portal.
  markLast(accepted: boolean): void {
    if (this.attempts.length > 0) this.attempts[this.attempts.length - 1].accepted = accepted;
  }

  // Record an attempt that did not go through the LLM (e.g. arithmetic solved locally).
  recordLocal(answer: string, mode: CaptchaMode): void {
    this.attempts.push({ provider: "local", mode, imageBytes: 0, answer, accepted: false, durationMs: 0 });
  }
}

// Thrown by connectors so the caller still gets captcha counts when a search fails.
// (Without this, failed runs report 0 attempts and the solve rate looks better than it is.)
export class SearchError extends Error {
  constructor(message: string, readonly captchaAttempts = 0, readonly captchaSolves = 0) {
    super(message);
    this.name = "SearchError";
  }
}

export async function solve(
  imageBase64: string,
  mode: CaptchaMode,
  mediaType: "image/png" | "image/jpeg" | "image/gif" = "image/png",
  tracker?: CaptchaTracker
): Promise<string> {
  const provider = (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini";
  consumeCaptchaCall(); // spend cap — throws when the day's budget is used up
  const start = Date.now();
  const answer = provider === "claude"
    ? await solveWithClaude(imageBase64, mode, mediaType)
    : await solveWithGemini(imageBase64, mode, mediaType);

  tracker?.attempts.push({
    provider,
    mode,
    imageBytes: Math.round((imageBase64.length * 3) / 4),
    answer,
    accepted: false, // set by the connector via tracker.markLast() after the portal responds
    durationMs: Date.now() - start,
  });

  return answer;
}

function captchaPrompt(mode: CaptchaMode): string {
  if (mode === "expression") {
    return "This image shows a short arithmetic expression, for example '27 plus 3' or '4 x 2'. Transcribe it exactly as written, keeping the spaces and operator words or symbols. Reply with ONLY the expression, do not solve it.";
  }
  if (mode === "math") {
    return "This image shows a math captcha (arithmetic expression). Solve it and reply with ONLY the numeric answer, nothing else.";
  }
  return "This is a captcha image. Read the text shown and reply with ONLY the captcha characters, no spaces or punctuation, in the exact case shown.";
}

async function solveWithClaude(
  imageBase64: string,
  mode: CaptchaMode,
  mediaType: "image/png" | "image/jpeg" | "image/gif" = "image/png"
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env — add it to solve captchas");
  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_CAPTCHA_MODEL ?? "claude-haiku-5-5";

  const prompt = captchaPrompt(mode);

  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType === "image/gif" ? "image/png" : mediaType, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  // Some models (e.g. haiku-5-5) emit a thinking block before the text block — find the text block
  const textBlock = msg.content.find(b => b.type === "text");
  const result = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  console.log(`[captcha] model=${model} stop=${msg.stop_reason} blocks=${msg.content.map(b => b.type).join(",")} result="${result}"`);
  return result;
}

async function solveWithGemini(
  imageBase64: string,
  mode: CaptchaMode,
  mediaType: "image/png" | "image/jpeg" | "image/gif" = "image/png"
): Promise<string> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = captchaPrompt(mode);

  const mimeType = mediaType === "image/gif" ? "image/png" : mediaType;
  const result = await model.generateContent([
    { inlineData: { mimeType, data: imageBase64 } },
    prompt,
  ]);

  return result.response.text().trim();
}
