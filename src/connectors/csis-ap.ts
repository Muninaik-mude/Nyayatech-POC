import { SearchInput, CaseResult, Tier } from "../core/types.js";
import { fetchWithTier, fetchBinary, detectImageType, FetchWithTierResult } from "../core/tiers.js";
import { solve, CaptchaTracker, SearchError } from "../core/captcha.js";
import { withCaptchaRetries } from "../core/captcha-loop.js";
import { solveMathCaptcha } from "../core/mathCaptcha.js";
import { decodeApResponse, parseApCsisRecord } from "../parsers/csis-ap.js";
import { hcServicesSearch } from "./hcservices.js";
import { captureFixture } from "../core/snapshot.js";
import { downloadOrderPdfs } from "../core/pdf.js";

// Real entry point of the AP High Court case-status site. (The old code used the bare host, which
// serves only a 46-byte placeholder page, and an invented /case_search.php.)
const BASE = "https://digi-courts.aphc.ap.gov.in/csis_ap";

export interface CsisApConnectorResult {
  caseResult: CaseResult;
  rawHtml: string;
  escalations: FetchWithTierResult["escalations"];
  tier: Tier;
  durationMs: number;
  bytes: number;
  captchaAttempts: number;
  captchaSolves: number;
  fieldsOnlyInDeep: string[];
}

// AP CSIS searches by registration number (type/number/year) or filing ("SR") number — there is no CNR search.
// If we only have a CNR we first resolve it to type/number/year through hcservices.
export async function csisApSearch(
  input: SearchInput,
  quickResult?: CaseResult,
  _runId?: string,
  _runsDir?: string,
  _forceTier?: Tier
): Promise<CsisApConnectorResult> {
  const start = Date.now();
  const tracker = new CaptchaTracker();
  let extraAttempts = 0, extraSolves = 0;

  let searchtype: "casenumber" | "srnumber";
  let mtype: string, mno: string, myear: string;
  if (input.searchBy === "filing" && input.filingNumber) {
    searchtype = "srnumber";
    [mtype, mno, myear] = [input.caseType ?? "", input.filingNumber, input.year ?? ""];
  } else {
    searchtype = "casenumber";
    [mtype, mno, myear] = [input.caseType ?? quickResult?.caseType ?? "", input.caseNumber ?? quickResult?.caseNumber ?? "", input.year ?? quickResult?.year ?? ""];
    if ((!mtype || !mno || !myear) && input.cnr) {
      const pre = await hcServicesSearch({ ...input, court: "high_court", bench: "APHC", searchBy: "cnr" }, "http");
      extraAttempts = pre.captchaAttempts; extraSolves = pre.captchaSolves;
      quickResult = pre.caseResult;
      [mtype, mno, myear] = [quickResult.caseType ?? "", quickResult.caseNumber ?? "", quickResult.year ?? ""];
    }
  }
  if (!mtype || !mno || !myear) {
    throw new SearchError("AP CSIS needs a case type + number + year, a filing number + year, or a CNR it can resolve");
  }

  const cookieJar = new Map<string, string>(); // the captcha answer lives in this session
  await fetchWithTier({ url: `${BASE}/`, method: "GET", cookieJar }, (h) => h.length > 1000, "http");

  const searchResult = await withCaptchaRetries<FetchWithTierResult>({
    tracker,
    maxAttempts: 4,
    delayMs: 500,
    label: "AP CSIS search",
    attempt: async () => {
      // The captcha is a JPEG of an arithmetic expression ("27 plus 3"): transcribe it, evaluate locally.
      const { bytes } = await fetchBinary(`${BASE}/loadCaptcha`, { cookieJar, accept: "image/*,*/*", headers: { Referer: `${BASE}/` } });
      const mediaType = detectImageType(bytes);
      if (!mediaType) throw new Error(`captcha response is not an image (${bytes.length} bytes)`);
      const expression = await solve(bytes.toString("base64"), "expression", mediaType, tracker);
      const answer = solveMathCaptcha(expression);
      if (answer === null) throw new Error(`could not evaluate captcha text "${expression}"`);

      const qs = new URLSearchParams({ searchtype, mtype, mno, myear, captcha: answer });
      let reason = "";
      try {
        return await fetchWithTier(
          { url: `${BASE}/getCaseDetails.action?${qs}`, method: "POST", cookieJar, headers: { "X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/` } },
          (html) => { const d = decodeApResponse(html); if (!d.ok) reason = d.reason; return d.ok; },
          "http" // the captcha is bound to the cookie jar
        );
      } catch (err) {
        throw new Error(reason || (err as Error).message);
      }
    },
  });

  await captureFixture("digi-courts.aphc.ap.gov.in", `${mtype}-${mno}-${myear}`.replace(/[^\w-]/g, "_"), searchResult.html); // raw, before parsing
  const decoded = decodeApResponse(searchResult.html);
  if (!decoded.ok) throw new SearchError(decoded.reason, tracker.total, tracker.accepted); // unreachable: validated above
  const caseResult = parseApCsisRecord(decoded.records[0], { tier: searchResult.tier });
  if (decoded.records.length > 1) {
    caseResult.courtData = { ...caseResult.courtData, otherRecords: decoded.records.slice(1) };
  }

  // Order PDFs: the portal serves them by form POST inside the same session.
  if (_runId && _runsDir && process.env.DOWNLOAD_ORDERS !== "0") {
    await downloadOrderPdfs(caseResult, { runId: _runId, runsDir: _runsDir, cookieJar, headers: { Referer: `${BASE}/` } });
  }

  return {
    caseResult,
    rawHtml: searchResult.html, // base64 body as served — saved verbatim by CAPTURE_FIXTURES
    escalations: searchResult.escalations,
    tier: searchResult.tier,
    durationMs: Date.now() - start,
    bytes: searchResult.bytes,
    captchaAttempts: tracker.total + extraAttempts,
    captchaSolves: tracker.accepted + extraSolves,
    fieldsOnlyInDeep: quickResult ? diffFields(quickResult, caseResult) : [],
  };
}

function diffFields(quick: CaseResult, deep: CaseResult): string[] {
  const onlyInDeep: string[] = [];
  for (const key of Object.keys(deep) as (keyof CaseResult)[]) {
    if (key === "dataSource" || key === "tier" || key === "fetchedAt" || key === "contentHash" || key === "warnings") continue;
    const qv = quick[key], dv = deep[key];
    if (!qv && dv && (typeof dv !== "object" || (Array.isArray(dv) && dv.length > 0))) onlyInDeep.push(key);
  }
  return onlyInDeep;
}
