# Courts POC

Throwaway proof-of-concept. Runs locally on an Indian IP (AP connection).  
Tests plain HTTP, Lightpanda, and Playwright/Chromium against district courts and high court portals.

## Setup

```bash
# 1. Install Node 22+ if not already installed
node --version  # should be v22.x

# 2. Install dependencies
npm install

# 3. Install Playwright Chromium (for T2 fallback)
npx playwright install chromium

# 4. Install Lightpanda (macOS native binary)
# See: https://lightpanda.io  — download the binary and start it:
# lightpanda serve --host 127.0.0.1 --port 9222

# 5. Copy env and add your keys
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY (and optionally GEMINI_API_KEY)

# 6. Run the dev server
npm run dev
# Open http://localhost:3000
```

## Usage

**Quick search** — hits `services.ecourts.gov.in` (district) or `hcservices.ecourts.gov.in` (HC).  
**Deep search** — hits the court's own site: AP HC (`digi-courts.aphc.ap.gov.in`) or TS HC (`csis.tshc.gov.in`).

Both buttons accept the same form inputs:
- **CNR** — paste the full CNR number (e.g. `APHC01-000001-2024`)
- **Case No** — case type (e.g. `OS`, `WP`) + number + year
- **Filing No** — filing number + year

Tier override lets you force HTTP / Lightpanda / Chromium. "All 3" runs the same query on all tiers and shows a comparison table.

## Benchmark

```bash
npm run bench
```

Reads `runs/runs.jsonl` and prints a summary table: success rate, avg latency, avg memory, captcha accuracy per portal/tier combo.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CAPTCHA_PROVIDER` | `claude` | `claude` or `gemini` |
| `ANTHROPIC_API_KEY` | — | Claude captcha solver |
| `CLAUDE_CAPTCHA_MODEL` | `claude-haiku-5-5` | Model for captcha |
| `GEMINI_API_KEY` | — | Gemini captcha (optional) |
| `DEFAULT_TIER` | `auto` | `auto`, `http`, `lightpanda`, `chromium` |
| `LIGHTPANDA_URL` | `ws://127.0.0.1:9222` | CDP endpoint |
| `PORT` | `3000` | Local server port |
| `RUNS_DIR` | `./runs` | Where raw HTML and metrics are written |

## Project layout

```
src/
  server.ts          Hono app: GET /, POST /api/quick, POST /api/deep
  core/
    types.ts         Types: CaseResult, SearchInput, RunMetrics
    tiers.ts         fetchWithTier(): T0 HTTP → T1 Lightpanda → T2 Chromium
    captcha.ts       solve() — Claude vision or Gemini, with attempt log
    metrics.ts       Build and append RunMetrics to runs.jsonl
    snapshot.ts      Save raw HTML and PDFs under runs/<runId>/
  connectors/
    district.ts      services.ecourts.gov.in
    hcservices.ts    hcservices.ecourts.gov.in
    csis-ap.ts       digi-courts.aphc.ap.gov.in (AP HC deep)
    csis-ts.ts       csis.tshc.gov.in (TS HC deep)
  bench.ts           Benchmark summary from runs.jsonl
public/index.html    The 2-button UI
runs/                Output — gitignored
fixtures/            Saved HTML for parser tests
```

## Notes

- **Indian IP required.** Portal access is geo-restricted. Run on an AP connection, no foreign VPN.
- **Lightpanda is AGPL-3.0.** Fine for local POC; check implications before production.
- **Do not commit `.env`** — share the Anthropic key via a password manager, set a spend limit in the console.
- **Test cases only.** Use public or consented cases. Keep volumes low and add delays.
