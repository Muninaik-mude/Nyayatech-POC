import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

export type CaptchaMode = "text" | "math";

export interface CaptchaAttempt {
  provider: "claude" | "gemini";
  mode: CaptchaMode;
  imageBytes: number;
  answer: string;
  accepted: boolean;
  durationMs: number;
}

const attempts: CaptchaAttempt[] = [];

export function getCaptchaAttempts(): CaptchaAttempt[] {
  return attempts;
}

export async function solve(
  imageBase64: string,
  mode: CaptchaMode,
  mediaType: "image/png" | "image/jpeg" | "image/gif" = "image/png"
): Promise<string> {
  const provider = (process.env.CAPTCHA_PROVIDER ?? "claude") as "claude" | "gemini";
  const start = Date.now();
  let answer = "";

  if (provider === "claude") {
    answer = await solveWithClaude(imageBase64, mode, mediaType);
  } else {
    answer = await solveWithGemini(imageBase64, mode, mediaType);
  }

  attempts.push({
    provider,
    mode,
    imageBytes: Math.round((imageBase64.length * 3) / 4),
    answer,
    accepted: false, // updated by connector after submission
    durationMs: Date.now() - start,
  });

  return answer;
}

export function markLastAttemptAccepted(accepted: boolean): void {
  if (attempts.length > 0) {
    attempts[attempts.length - 1].accepted = accepted;
  }
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

  const prompt =
    mode === "math"
      ? "This image shows a math captcha (arithmetic expression). Solve it and reply with ONLY the numeric answer, nothing else."
      : "This is a captcha image. Read the text shown and reply with ONLY the captcha characters, no spaces or punctuation, in the exact case shown.";

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

  const prompt =
    mode === "math"
      ? "This image shows a math captcha. Solve it and reply with ONLY the numeric answer."
      : "This is a captcha image. Reply with ONLY the captcha text, no explanation.";

  const mimeType = mediaType === "image/gif" ? "image/png" : mediaType;
  const result = await model.generateContent([
    { inlineData: { mimeType, data: imageBase64 } },
    prompt,
  ]);

  return result.response.text().trim();
}
