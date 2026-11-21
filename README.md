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

## Project layout

```
src/
  server.ts          Hono app: GET /, POST /api/quick, POST /api/deep
  core/
    types.ts         Types: CaseResult, SearchInput, RunMetrics
    tiers.ts         fetchWithTier(): T0 HTTP → T1 Lightpanda → T2 Chromium
    captcha.ts       solve() — Claude vision or Gemini; CaptchaTracker (per run), SearchError
    captcha-loop.ts  withCaptchaRetries(): retry loop shared by every connector
    mathCaptcha.ts   Local solver for arithmetic captchas (no LLM call)
    pdf.ts           downloadPdf(): raw-bytes download + %PDF check
    queue.ts         p-limit queue; job state mirrored to runs/jobs/
    metrics.ts       Build and append RunMetrics to runs.jsonl
    snapshot.ts      Save raw HTML and PDFs under runs/<runId>/
  connectors/
    district.ts      services.ecourts.gov.in
    hcservices.ts    hcservices.ecourts.gov.in
    csis-ap.ts       digi-courts.aphc.ap.gov.in (AP HC deep)
    csis-ts.ts       csis.tshc.gov.in (TS HC deep)
  parsers/
    hcservices-case.ts  HC case page + filing list → common CaseResult schema
  bench.ts           Benchmark summary from runs.jsonl
public/index.html    The UI
tests/               node:test — parsers (against fixtures), captcha, PDF, queue
runs/                Output — gitignored
fixtures/            Real saved portal responses, one folder per portal
  hcservices/        11 case pages (10 courts) + 1 filing-search list
  captured/          Gitignored inbox for new captures (see below)
```

## Tests and fixtures

```bash
npm test            # 151 tests; no external network, no API keys needed
npm run report      # measurement table from runs/runs.jsonl (success, captcha solve rate, median/p90)
npm run build-hierarchy  # state → district [→ complex] reference tree via a real Chrome (LEVEL=complexes for the full ~800-lookup crawl)
npm run rate-probe  # how many requests/min this IP tolerates before a portal blocks (captcha-free page)
npm run typecheck
```

**Rule: no parser change without a fixture.** Every selector in `src/parsers/` was written against a
real page in `fixtures/`, and the tests assert row counts against the raw HTML so nothing is silently dropped.

Capturing a fixture for a screen we have not seen yet (cause lists, interim orders, process details,
district v6 results, AP/TS CSIS pages):

```bash
CAPTURE_FIXTURES=1 npm run dev     # every successful search also saves its raw response
# → fixtures/captured/<portal>/<id>.html
```
Review the file (it is real court data), move it to `fixtures/<portal>/`, then write the parser and its test.

## Data model

`CaseResult` (`src/core/types.ts`) is the common superset schema: identity (filing / registration / CNR /
`sourceCaseId`), status (stage, decision date, nature of disposal, category), hearings with business-on date and
hearing date separate, parties linked to their advocates, structured acts and FIR, orders, IA applications,
objections, filed documents, linked cases, lower-court details, and `courtData` for source-specific leftovers.
New date fields are ISO `YYYY-MM-DD`; legacy display fields keep the portal's raw text. `contentHash` is a
sha256 of the case content (not tier or fetch time) for change detection.

| Source | State | Notes |
|---|---|---|
| hcservices — CNR case page | **verified** against 11 real pages (10 courts) | all fields above except those below |
| hcservices — filing search list | **verified** against a real response | other matches kept in `courtData.otherMatches` |
| AP CSIS (`digi-courts.aphc.ap.gov.in/csis_ap/`) | **verified** against 4 real responses (captured live 2026-11-21: pending, disposed, with orders) | Identity, status, numbered parties + addresses (PII, in `courtData`), IA/MP applications, lower court, orders (no PDF link exists in the response, so none is invented), vakalath advocates, prayer. USR details, digital orders and connected cases keep their raw shape in `courtData`. Captcha ("91 plus 5") is read by the LLM and evaluated locally. |
| TS CSIS (`csis.tshc.gov.in`) | **not implemented** | Behind a JavaScript bot challenge that plain HTTP cannot pass; endpoints not mapped. Fails fast with a clear message. Telangana is searchable by CNR via hcservices (`HBHC`). |
| district (`services.ecourts.gov.in/ecourtindia_v6`) | **partly fixed, still unverified** | Captcha URL bug fixed (checked against the real home page, saved in `fixtures/district/`). The v6 search itself is multi-step AJAX with `app_token` chaining and custom headers — not mapped; results carry a `warnings` entry. |
| AP cause list (`aphc.gov.in/Hcdbs`) | **verified** against a real page (court 2, 78 entries) | Public, no captcha. `GET /api/cause-list/ap/dates`, `/courts`, `/api/cause-list/ap?type=D&date=YYYY-MM-DD&court=2`. Cached 10 min. Unregistered cases flagged `filingNumberOnly`. |
| TS cause list | **not built** | Same bot-challenge site as TS CSIS |
| Court hierarchy (state → district → complex) | **script built and proven, data not yet saved** | `npm run build-hierarchy` read 36 states and a state's districts through Chrome in an earlier run; the portal then began answering HTTP 405 to this IP (even plain curl), so no file was written. The script refuses to write an empty result. Re-run later. |
| Order PDFs (AP) | **done, verified live** | POST `sdcorderpdf.action` / `sdceorderpdf.action` in the CSIS session; both order types of WP 1/2020 downloaded as real PDFs |
| Pre-2013 CNRs | **answered** | AP HC cases from 2008, 2011 and 2012 all have `APHC01…` CNRs. (2005 returned nothing — not conclusive.) |
| Interim orders, process details, caveat, transfers, notices | **not built** | Never present in any saved page, so nothing to parse without inventing it — capture a case that has them first |
| Case duration | **done** | `caseDurationDays`: filing (else registration) → decision date, or → today while pending. Excluded from `contentHash`. |
| Order PDFs | **wired** | The CNR job downloads each linked order PDF (max 10, `DOWNLOAD_ORDERS=0` to disable); dead links become `warnings`, not failures |

## Security

Off-by-default conveniences are closed by default (all configurable in `.env`, see `.env.example`):

- **Auth:** `API_KEYS=k1,k2` requires `Authorization: Bearer <key>` or `X-API-Key` on every `/api/*` route (constant-time compare). The UI asks for the key once on a 401.
- **Listen address:** the server binds to `127.0.0.1`. Any other `HOST` refuses to start unless `API_KEYS` is set.
- **CORS:** closed unless `CORS_ORIGINS` lists the origin (the bundled UI is same-origin).
- **Rate limit:** `RATE_LIMIT_PER_MIN` (default 30) per key on the routes that cost a captcha solve; `429` with `Retry-After`.
- **Validation:** every search body is checked (court, bench, CNR format, case type/number/year, tier) and size-capped; `400` lists every problem.
- **Debug routes** (`/api/debug/*`, which fetch arbitrary URLs) are off unless `ENABLE_DEBUG=1`, and limited to `*.gov.in`.
- **Cache:** repeat CNR lookups within `CNR_CACHE_MINUTES` (default 15) cost no captcha and no portal hit; simultaneous identical requests share one upstream call.
- **Cost cap:** `CAPTCHA_DAILY_BUDGET` (default 2000) limits paid LLM captcha calls per UTC day; see `GET /api/captcha/budget`. In-memory — resets on restart.

**Lightpanda (AGPL-3.0):** the auto tier ladder skips it unless `ENABLE_LIGHTPANDA=1`, so by default nothing AGPL is used or contacted; HTTP and Chromium cover every working portal. Whether *using* it in a hosted service triggers AGPL obligations is a legal question this repo cannot answer — decide before enabling it in production.

**Rate probe (2026-11-21, this laptop IP, captcha-free AP cause-list endpoint):** 21 requests over ~2 minutes, ramping 6 → 12 → 24 per minute, no blocking. That is a lower bound, not a ceiling — it stopped at 24/min on purpose. Captcha-gated case searches are limited by solves, not by this.

**Deployment:** still a decision for you, not code: portals need an Indian egress IP. Run `npm run rate-probe` from the candidate host first to see what it tolerates.

## Measured so far (132 historical runs, 14–20 Nov 2026)

| Portal / tier | Runs | Succeeded | Median s | p90 s |
|---|---|---|---|---|
| hcservices / http | 113 | 83 (73%) | 4.8 | 8.7 |
| hcservices / chromium | 7 | 4 | 4.5 | 5.1 |
| hcservices / lightpanda | 8 | 0 | — | — (Lightpanda was not running: ECONNREFUSED) |
| services.ecourts (district) / http | 2 | 0 | — | — |

Captcha solve rate and requests-per-hour-per-IP are **not** reported: the old counters were module-level and
never reset (759 "solves" against 145 attempts), and nobody has load-tested a single IP. Both are measurable from
new runs now that counts are per search and failed searches report theirs too.

## Notes

- **Indian IP required.** Portal access is geo-restricted. Run on an AP connection, no foreign VPN.
- **Lightpanda is AGPL-3.0.** Fine for local POC; check implications before production.
- **Do not commit `.env`** — share the Anthropic key via a password manager, set a spend limit in the console.
- **Test cases only.** Use public or consented cases. Keep volumes low and add delays.
