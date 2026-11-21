import { SearchInput, CaseResult, Tier } from "../core/types.js";
import { fetchWithTier, fetchImageBytes, FetchWithTierResult } from "../core/tiers.js";
import { solve, CaptchaTracker, SearchError } from "../core/captcha.js";
import { withCaptchaRetries } from "../core/captcha-loop.js";
import { parseHcCaseHtml, parseFilingList, isCaseDetailPage, isFilingListResponse, normaliseCnr } from "../parsers/hcservices-case.js";

const BASE = "https://hcservices.ecourts.gov.in/ecourtindiaHC";
const NEW_BASE = "https://hcservices.ecourts.gov.in/hcservices";

// Maps our bench code → state_cd / stateNm used by index_highcourt.php
export const BENCH_TO_STATE: Record<string, { state_cd: number; stateNm: string }> = {
  APHC: { state_cd: 2,  stateNm: "Andhra Pradesh" },
  TSHC: { state_cd: 29, stateNm: "Telangana" },
  TNHC: { state_cd: 10, stateNm: "Madras" },
  BHHC: { state_cd: 1,  stateNm: "Bombay" },
  KRHC: { state_cd: 3,  stateNm: "Karnataka" },
  KLHC: { state_cd: 4,  stateNm: "Kerala" },
  ALHC: { state_cd: 13, stateNm: "Uttar Pradesh" },
  CLHC: { state_cd: 16, stateNm: "Calcutta" },
  GUHC: { state_cd: 17, stateNm: "Gujarat" },
  RJHC: { state_cd: 9,  stateNm: "Rajasthan" },
  ORHC: { state_cd: 11, stateNm: "Odisha" },
  PTHC: { state_cd: 8,  stateNm: "Patna" },
  GWHC: { state_cd: 6,  stateNm: "Assam" },
  JKHC: { state_cd: 12, stateNm: "Jammu and Kashmir and Ladakh" },
  HPHC: { state_cd: 5,  stateNm: "Himachal Pradesh" },
  UKHC: { state_cd: 15, stateNm: "Uttarakhand" },
  JHHC: { state_cd: 7,  stateNm: "Jharkhand" },
  CGHC: { state_cd: 18, stateNm: "Chhattisgarh" },
  MPHC: { state_cd: 19, stateNm: "Madhya Pradesh" },
  PHHC: { state_cd: 22, stateNm: "Punjab" },
};

export const HC_BENCHES: Record<string, string> = {
  APHC: "Andhra Pradesh High Court",
  TSHC: "Telangana High Court",
  DLHC: "Delhi High Court",
  TNHC: "Madras High Court",
  BHHC: "Bombay High Court",
  KRHC: "Karnataka High Court",
  KLHC: "Kerala High Court",
  ALHC: "Allahabad High Court",
  CLHC: "Calcutta High Court",
  GUHC: "Gujarat High Court",
  MPHC: "Madhya Pradesh High Court",
  RJHC: "Rajasthan High Court",
  PHHC: "Punjab and Haryana High Court",
  ORHC: "Orissa High Court",
  PTHC: "Patna High Court",
  GWHC: "Gauhati High Court",
  JKHC: "Jammu and Kashmir High Court",
  HPHC: "Himachal Pradesh High Court",
  UKHC: "Uttarakhand High Court",
  JHHC: "Jharkhand High Court",
  CGHC: "Chhattisgarh High Court",
  SKHC: "Sikkim High Court",
  TRHC: "Tripura High Court",
};

// CNR prefix → hcservices bench code
export const CNR_PREFIX_TO_BENCH: Record<string, string> = {
  APHC: "APHC", TSHC: "TSHC", DLHC: "DLHC",
  HCMA: "TNHC", TNHC: "TNHC",
  HCBM: "BHHC", BHHC: "BHHC",
  KAHC: "KRHC", KRHC: "KRHC",
  KLHC: "KLHC",
  ALHC: "ALHC", CLHC: "CLHC", GUHC: "GUHC",
  HCMP: "MPHC", MPHC: "MPHC",
  RJHC: "RJHC", PHHC: "PHHC", ORHC: "ORHC",
  PTHC: "PTHC", GWHC: "GWHC", JKHC: "JKHC",
  HPHC: "HPHC", UKHC: "UKHC", JHHC: "JHHC", CGHC: "CGHC",
  // Additional prefixes found in the wild
  HBHC: "TSHC",  // Telangana HC uses HBHC prefix
  ODHC: "ORHC",  // Orissa HC uses ODHC prefix
  GJHC: "GUHC",  // Gujarat HC uses GJHC prefix
  SKHC: "SKHC",  // Sikkim HC
  TRHC: "TRHC",  // Tripura HC
};

export interface HcServicesConnectorResult {
  caseResult: CaseResult;
  rawHtml: string;
  escalations: FetchWithTierResult["escalations"];
  tier: Tier;
  durationMs: number;
  bytes: number;
  captchaAttempts: number;
  captchaSolves: number;
}

export { normaliseCnr };

// Parse CNR → court_code, filingNo, year
// Format: SSCC + NN + NNNNNN + YYYY  e.g. KAHC 01 074795 2026
function parseCnr(cnr: string): { courtCode: number; filingNo: string; year: string } | null {
  const m = normaliseCnr(cnr).match(/^[A-Z]{4}(\d{2})(\d{6})(\d{4})$/);
  if (!m) return null;
  return {
    courtCode: parseInt(m[1], 10),
    filingNo: String(parseInt(m[2], 10)), // strip leading zeros
    year: m[3],
  };
}

export async function hcServicesSearch(input: SearchInput, forceTier?: Tier): Promise<HcServicesConnectorResult> {
  const start = Date.now();
  const bench = input.bench ?? "APHC";

  // CNR search uses the new portal which returns full case details
  if (input.searchBy === "cnr" && input.cnr) {
    return hcServicesSearchCnr(input.cnr, bench, start, forceTier);
  }

  // Filing/case number search uses old portal
  return hcServicesSearchFiling(input, bench, start, forceTier);
}

async function hcServicesSearchCnr(
  cnrRaw: string,
  bench: string,
  start: number,
  forceTier?: Tier,
): Promise<HcServicesConnectorResult> {
  const cnr = normaliseCnr(cnrRaw); // strip dashes, uppercase
  const tracker = new CaptchaTracker();
  const cookieJar = new Map<string, string>();
  const sessionUrl = `${NEW_BASE}/main.php`;

  const sessionResult = await fetchWithTier(
    {
      url: sessionUrl,
      method: "GET",
      cookieJar,
      headers: {
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    },
    (html) => html.length > 1000,
    forceTier
  );

  // Captcha is in <img id="captcha_image" src="/hcservices/securimage/securimage_show.php?HASH">
  const captchaMatch = sessionResult.html.match(/id="captcha_image"\s+src="([^"]+)"/);
  if (!captchaMatch) {
    throw new SearchError("HC CNR search: captcha image not found on the session page (portal layout changed?)");
  }
  const captchaUrl = captchaMatch[1].startsWith("http")
    ? captchaMatch[1]
    : `https://hcservices.ecourts.gov.in${captchaMatch[1]}`;
  console.log(`[hcservices/cnr] session: ${sessionResult.html.length}B captcha=${captchaUrl}`);

  const postUrl = `${NEW_BASE}/cases_qry/index_qry.php`;
  const MAX_ATTEMPTS = 5;

  const searchResult = await withCaptchaRetries<FetchWithTierResult>({
    tracker,
    maxAttempts: MAX_ATTEMPTS,
    delayMs: 1000, // don't hammer the portal on retries
    label: "HC CNR search",
    attempt: async (attempt) => {
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl, cookieJar);
      const raw = await solve(bytes.toString("base64"), "text", mediaType, tracker);
      // Try lowercase on odd attempts as a fallback for case-sensitive portals
      const captchaSolution = attempt % 2 === 0 ? raw : raw.toLowerCase();
      console.log(`[hcservices/cnr] attempt ${attempt + 1}/${MAX_ATTEMPTS} solved "${raw}" → submitting "${captchaSolution}"`);

      let rejection = "";
      try {
        // Always HTTP for the AJAX POST — browser tiers don't carry the cookieJar session,
        // so captcha verification would always fail there.
        return await fetchWithTier(
          {
            url: postUrl,
            method: "POST",
            body: {
              cino: cnr,
              action_code: "fetchStateDistCourtNew",
              caseStatusSearchType: "CNRNumber",
              captcha: captchaSolution,
              appFlag: "web",
            },
            cookieJar,
            headers: {
              "Referer": sessionUrl,
              "X-Requested-With": "XMLHttpRequest",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
          },
          // Accept ONLY a real case page. "Invalid Captcha", "null", errors, empty bodies fail here.
          (html) => {
            if (isCaseDetailPage(html)) return true;
            rejection = html.trim().slice(0, 80) || "(empty)";
            return false;
          },
          "http"
        );
      } catch (err) {
        throw new Error(rejection ? `portal replied: ${rejection}` : (err as Error).message);
      }
    },
  });

  const caseResult = parseHcCaseHtml(searchResult.html, { tier: searchResult.tier, bench, courtName: HC_BENCHES[bench] });

  return {
    caseResult,
    rawHtml: searchResult.html,
    escalations: searchResult.escalations,
    tier: searchResult.tier,
    durationMs: Date.now() - start,
    bytes: searchResult.bytes,
    captchaAttempts: tracker.total,
    captchaSolves: tracker.accepted,
  };
}

async function hcServicesSearchFiling(
  input: SearchInput,
  bench: string,
  start: number,
  forceTier?: Tier,
): Promise<HcServicesConnectorResult> {
  const tracker = new CaptchaTracker();

  const benchState = BENCH_TO_STATE[bench];
  if (!benchState) throw new SearchError(`No portal mapping for bench "${bench}" — not supported on hcservices`);

  const { state_cd, stateNm } = benchState;
  const court_code = 1;
  const filingNo = input.searchBy === "filing" ? (input.filingNumber ?? "") : (input.caseNumber ?? "");
  const year = input.year ?? "";

  const cookieJar = new Map<string, string>();
  const parentUrl = `${BASE}/index_highcourt.php?state_cd=${state_cd}&dist_cd=1&stateNm=${encodeURIComponent(stateNm)}`;
  const sessionUrl = `${BASE}/cases/c_index.php?state_cd=${state_cd}&dist_cd=1&court_code=${court_code}&stateNm=${encodeURIComponent(stateNm)}`;
  console.log(`[hcservices/filing] bench=${bench} sessionUrl=${sessionUrl}`);

  const sessionResult = await fetchWithTier(
    {
      url: sessionUrl,
      method: "GET",
      cookieJar,
      headers: {
        "Referer": parentUrl,
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
    },
    (html) => html.length > 1000,
    forceTier
  );

  const csrfToken = sessionResult.html.match(/var csrfMagicToken\s*=\s*"([^"]+)"/)?.[1] ?? "";

  const captchaMatch = sessionResult.html.match(/src="([^"]*securimage_show\.php\?[^"]+)"/);
  if (!captchaMatch) {
    throw new SearchError("HC filing search: captcha image not found on the session page (portal layout changed?)");
  }
  const captchaUrl = captchaMatch[1].startsWith("http")
    ? captchaMatch[1]
    : `https://hcservices.ecourts.gov.in${captchaMatch[1]}`;
  console.log(`[hcservices/filing] session: ${sessionResult.html.length}B csrf=${csrfToken ? "found" : "MISSING"} captcha=${captchaUrl}`);

  const postUrl = `${BASE}/cases/filling_no_qry.php`;

  const searchResult = await withCaptchaRetries<FetchWithTierResult>({
    tracker,
    maxAttempts: 3,
    label: "HC filing search",
    attempt: async () => {
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl, cookieJar);
      const captchaSolution = await solve(bytes.toString("base64"), "text", mediaType, tracker);
      console.log(`[hcservices/filing] captcha solved: "${captchaSolution}"`);

      const postBody: Record<string, string> = {
        action_code: "showRecords",
        state_code: String(state_cd),
        dist_code: "1",
        court_code: String(court_code),
        case_no: filingNo,
        rgyear: year,
        captcha: captchaSolution,
      };
      if (csrfToken) postBody["__csrf_magic"] = csrfToken;

      let rejection = "";
      try {
        return await fetchWithTier(
          {
            url: postUrl,
            method: "POST",
            body: postBody,
            cookieJar,
            headers: {
              "Referer": sessionUrl,
              "X-Requested-With": "XMLHttpRequest",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
          },
          // Only a result list or a case page counts — not errors, "Invalid Captcha" or empty bodies.
          (html) => {
            if (isFilingListResponse(html) || isCaseDetailPage(html)) return true;
            rejection = html.trim().slice(0, 80) || "(empty)";
            return false;
          },
          "http" // same reason as the CNR flow: the captcha is bound to the cookie jar session
        );
      } catch (err) {
        throw new Error(rejection ? `portal replied: ${rejection}` : (err as Error).message);
      }
    },
  });

  const parseOpts = { tier: searchResult.tier, bench, courtName: HC_BENCHES[bench] };
  const caseResult = isCaseDetailPage(searchResult.html)
    ? parseHcCaseHtml(searchResult.html, parseOpts)
    : parseFilingList(searchResult.html, parseOpts);

  return {
    caseResult,
    rawHtml: searchResult.html,
    escalations: searchResult.escalations,
    tier: searchResult.tier,
    durationMs: Date.now() - start,
    bytes: searchResult.bytes,
    captchaAttempts: tracker.total,
    captchaSolves: tracker.accepted,
  };
}

