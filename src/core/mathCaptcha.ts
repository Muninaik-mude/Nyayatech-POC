// Local solver for arithmetic captchas ("three plus five", "12 - 4", "7 x 3").
// No LLM call: the expression is plain text, so evaluate it directly.

const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const OPERATORS: [RegExp, string][] = [
  // Symbols must stand alone: a bare "x" would match inside "six", a bare "-" inside "twenty-one".
  [/\bmultiplied\s+by\b|\btimes\b|(?<![A-Za-z])x(?![A-Za-z])|[×*]/i, "*"],
  [/\bdivided\s+by\b|\bover\b|[÷/]/i, "/"],
  [/\bplus\b|\badd(?:ed)?\s+to\b|\+/i, "+"],
  [/\bminus\b|\bless\b|(?<=[\d\s])[-−–](?=[\d\s])/i, "-"],
];

function parseNumber(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t in WORDS) return WORDS[t];
  // "twenty-one", "twenty one"
  const parts = t.split(/[\s-]+/);
  if (parts.length === 2 && parts[0] in WORDS && parts[1] in WORDS && WORDS[parts[0]] >= 20 && WORDS[parts[1]] < 10) {
    return WORDS[parts[0]] + WORDS[parts[1]];
  }
  return null;
}

// Returns the answer as a string, or null if the text is not a recognisable "<a> <op> <b>" expression.
export function solveMathCaptcha(raw: string): string | null {
  const text = raw
    .replace(/(\d)([A-Za-z])/g, "$1 $2") // "27plus3" -> "27 plus 3"
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/[=?]/g, " ")
    .replace(/\b(what|is|equals?|the|answer|of|sum|result)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [re, op] of OPERATORS) {
    const m = re.exec(text);
    if (!m) continue;
    const left = parseNumber(text.slice(0, m.index));
    const right = parseNumber(text.slice(m.index + m[0].length));
    if (left === null || right === null) continue;
    let result: number;
    switch (op) {
      case "+": result = left + right; break;
      case "-": result = left - right; break;
      case "*": result = left * right; break;
      default:
        if (right === 0) return null;
        result = left / right;
    }
    if (!Number.isFinite(result) || !Number.isInteger(result)) return null;
    return String(result);
  }
  return null;
}
