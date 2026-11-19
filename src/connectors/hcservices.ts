import * as cheerio from "cheerio";
import { SearchInput, CaseResult, Tier } from "../core/types.js";
import { fetchWithTier, fetchImageBytes, FetchWithTierResult } from "../core/tiers.js";
import { solve, markLastAttemptAccepted } from "../core/captcha.js";

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
}

// Normalise CNR — strip dashes (e.g. APHC01-059651-2026 → APHC010596512026)
export function normaliseCnr(cnr: string): string {
  return cnr.trim().toUpperCase().replace(/-/g, "");
}

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
  let captchaAttempts = 0;
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
  const captchaUrl = captchaMatch
    ? (captchaMatch[1].startsWith("http")
        ? captchaMatch[1]
        : `https://hcservices.ecourts.gov.in${captchaMatch[1]}`)
    : null;

  console.log(`[hcservices/cnr] session: ${sessionResult.html.length}B captcha=${captchaUrl ?? "NOT FOUND"}`);

  const postUrl = `${NEW_BASE}/cases_qry/index_qry.php`;
  let searchResult: FetchWithTierResult | null = null;
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    captchaAttempts++;

    // Small delay from attempt 2 onwards so the portal isn't hammered
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000));

    let captchaSolution = "000000";
    if (captchaUrl) {
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl, cookieJar);
      console.log(`[hcservices/cnr] attempt ${attempt + 1}/${MAX_ATTEMPTS} captcha image: ${bytes.length}B ${mediaType}`);
      const raw = await solve(bytes.toString("base64"), "text", mediaType);
      // Try lowercase on even attempts as a fallback for case-sensitive portals
      captchaSolution = attempt % 2 === 0 ? raw : raw.toLowerCase();
      console.log(`[hcservices/cnr] captcha solved: "${raw}" → submitting: "${captchaSolution}"`);
    }

    const postBody: Record<string, string> = {
      cino: cnr.trim().toUpperCase(),
      action_code: "fetchStateDistCourtNew",
      caseStatusSearchType: "CNRNumber",
      captcha: captchaSolution,
      appFlag: "web",
    };

    console.log(`[hcservices/cnr] POST to ${postUrl} cino=${postBody.cino}`);

    let lastRejection = "";
    try {
      // Always use HTTP for the AJAX POST — browser tiers (lightpanda/chromium) don't
      // carry the cookieJar session cookie, so captcha verification would always fail
      searchResult = await fetchWithTier(
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
        (html) => {
          const trimmed = html.trim();
          if (trimmed === "" || trimmed === "null" || trimmed === "Invalid Captcha" || trimmed === "THERE IS AN ERROR") {
            lastRejection = trimmed || "(empty)";
            return false;
          }
          if (trimmed.toLowerCase().startsWith("error")) {
            lastRejection = trimmed.slice(0, 80);
            return false;
          }
          console.log(`[hcservices/cnr] response: ${html.length}B preview="${html.slice(0, 200).replace(/\s+/g, " ")}"`);
          return html.length > 100;
        },
        "http"
      );
      markLastAttemptAccepted(true);
      break;
    } catch {
      console.log(`[hcservices/cnr] attempt ${attempt + 1} rejected: "${lastRejection}"`);
      markLastAttemptAccepted(false);
    }
  }

  if (!searchResult) {
    throw new Error(`HC CNR search failed: captcha not solved after ${MAX_ATTEMPTS} attempts`);
  }

  const caseResult = parseNewPortalCase(searchResult.html, searchResult.tier, bench);

  return {
    caseResult,
    rawHtml: searchResult.html,
    escalations: searchResult.escalations,
    tier: searchResult.tier,
    durationMs: Date.now() - start,
    bytes: searchResult.bytes,
    captchaAttempts,
  };
}

async function hcServicesSearchFiling(
  input: SearchInput,
  bench: string,
  start: number,
  forceTier?: Tier,
): Promise<HcServicesConnectorResult> {
  let captchaAttempts = 0;

  const benchState = BENCH_TO_STATE[bench];
  if (!benchState) throw new Error(`No portal mapping for bench "${bench}" — not supported on hcservices`);

  const { state_cd, stateNm } = benchState;

  let court_code = 1;
  let filingNo = "";
  let year = "";

  if (input.searchBy === "filing") {
    filingNo = input.filingNumber ?? "";
    year = input.year ?? "";
  } else {
    filingNo = input.caseNumber ?? "";
    year = input.year ?? "";
  }

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

  const csrfMatch = sessionResult.html.match(/var csrfMagicToken\s*=\s*"([^"]+)"/);
  const csrfToken = csrfMatch?.[1] ?? "";

  const captchaMatch2 = sessionResult.html.match(/src="([^"]*securimage_show\.php\?[^"]+)"/);
  const captchaUrl = captchaMatch2
    ? (captchaMatch2[1].startsWith("http")
        ? captchaMatch2[1]
        : `https://hcservices.ecourts.gov.in${captchaMatch2[1]}`)
    : null;

  console.log(`[hcservices/filing] session: ${sessionResult.html.length}B csrf=${csrfToken ? "found" : "MISSING"} captcha=${captchaUrl ?? "NOT FOUND"}`);

  const postUrl = `${BASE}/cases/filling_no_qry.php`;
  let searchResult: FetchWithTierResult | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    captchaAttempts++;

    let captchaSolution = "0000";
    if (captchaUrl) {
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl, cookieJar);
      console.log(`[hcservices/filing] captcha image: ${bytes.length}B ${mediaType}`);
      captchaSolution = await solve(bytes.toString("base64"), "text", mediaType);
      console.log(`[hcservices/filing] captcha solved: "${captchaSolution}"`);
    }

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

    console.log(`[hcservices/filing] POST body=${JSON.stringify(postBody)}`);

    try {
      searchResult = await fetchWithTier(
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
        (html) => {
          const isError = html.toLowerCase().startsWith("error") || html.trim() === "";
          console.log(`[hcservices/filing] AJAX response: ${html.length}B isError=${isError} preview="${html.slice(0, 200).replace(/\s+/g, " ")}"`);
          return !isError && html.length > 20;
        },
        forceTier
      );
      markLastAttemptAccepted(true);
      break;
    } catch {
      markLastAttemptAccepted(false);
    }
  }

  if (!searchResult) {
    throw new Error("HC services search failed: captcha not solved after 3 attempts");
  }

  const caseResult = parseHcServicesCase(searchResult.html, searchResult.tier, bench);

  return {
    caseResult,
    rawHtml: searchResult.html,
    escalations: searchResult.escalations,
    tier: searchResult.tier,
    durationMs: Date.now() - start,
    bytes: searchResult.bytes,
    captchaAttempts,
  };
}

// Strip HTML tags and normalize whitespace
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Parse the full case detail HTML returned by the new portal (/hcservices/cases_qry/index_qry.php)
function parseNewPortalCase(html: string, tier: Tier, bench: string): CaseResult {
  const $ = cheerio.load(html);
  const court = HC_BENCHES[bench] ?? bench;

  // Helper: find table cell value next to a label cell
  const cellVal = (label: string): string => {
    let val = "";
    $("td, th").each((_, el) => {
      const text = $(el).text().trim();
      if (text === label) {
        // Try the next sibling td
        const next = $(el).next("td");
        if (next.length) val = next.text().trim();
      }
    });
    return val;
  };

  const filingNumber = cellVal("Filing Number");
  const filingDate = cellVal("Filing Date");
  const registrationNumber = cellVal("Registration Number");
  const cnr = cellVal("CNR Number");
  const caseStage = cellVal("Case Stage");
  const nextHearingDate = cellVal("Next Hearing Date");
  const firstHearingDate = cellVal("First Hearing Date");
  const coram = cellVal("Coram");
  const benchType = cellVal("Bench Type");

  // Case type from registration number e.g. "WP /5826/2026" → "WP"
  const caseType = registrationNumber.match(/^([A-Z][A-Z.]*)\s*\//)?.[1] ?? "";

  const status = caseStage
    || $("h2:contains('Case Status'), .case-status-heading").first().text().trim()
    || "PRELIMINARY HEARING";

  const judge = coram;

  // Petitioner and Advocate section
  const parties: CaseResult["parties"] = [];
  const advocates: CaseResult["advocates"] = [];

  // "Petitioner and Advocate" table — each row has petitioner name + advocate
  $("table").each((_, tbl) => {
    const caption = $(tbl).prev("table").find("th:contains('Petitioner'), td:contains('Petitioner')").length
      || $(tbl).find("th:contains('Petitioner'), th:contains('petitioner')").length
      || $(tbl).prev().text().includes("Petitioner");
    // Look for the section heading nearby
    const heading = $(tbl).closest("div, section").prev().text().trim()
      || $(tbl).prev("table").find("th").text().trim()
      || "";

    if (heading.includes("Petitioner") || $(tbl).find("th:contains('Petitioner')").length) {
      $(tbl).find("tr").each((_, row) => {
        const cells = $(row).find("td");
        const name = cells.eq(0).text().trim();
        const advocate = cells.eq(1).text().replace("Advocate-", "").replace("Advocate -", "").trim();
        if (name && !name.startsWith("Sr.")) {
          parties.push({ name, role: "petitioner", advocate: advocate || undefined });
          if (advocate) advocates.push({ name: advocate, role: "petitioner_advocate" });
        }
      });
    }
    if (heading.includes("Respondent") || $(tbl).find("th:contains('Respondent')").length) {
      $(tbl).find("tr").each((_, row) => {
        const cells = $(row).find("td");
        const name = cells.eq(0).text().trim();
        const advocate = cells.eq(1).text().replace("Advocate-", "").replace("Advocate -", "").trim();
        if (name && !name.startsWith("Sr.")) {
          parties.push({ name, role: "respondent", advocate: advocate || undefined });
          if (advocate) advocates.push({ name: advocate, role: "respondent_advocate" });
        }
      });
    }
  });

  // Fallback: find sections by nearby heading text
  if (parties.length === 0) {
    const bodyText = $.html();
    const petSection = bodyText.match(/Petitioner and Advocate[\s\S]{0,5000}?Respondent and Advocate/);
    const respSection = bodyText.match(/Respondent and Advocate[\s\S]{0,5000}/);

    if (petSection) {
      const $pet = cheerio.load(petSection[0]);
      $pet("td").each((_, el) => {
        const t = $pet(el).text().trim();
        if (t && t.length > 2 && !t.includes("Petitioner") && !t.includes("Sr.")) {
          if (t.startsWith("Advocate") || t.startsWith("Adv")) {
            advocates.push({ name: t.replace(/^Advocate[- ]*/, ""), role: "petitioner_advocate" });
          } else {
            parties.push({ name: t, role: "petitioner" });
          }
        }
      });
    }
    if (respSection) {
      const $resp = cheerio.load(respSection[0]);
      $resp("td").each((_, el) => {
        const t = $resp(el).text().trim();
        if (t && t.length > 2 && !t.includes("Respondent") && !t.includes("Sr.")) {
          if (t.startsWith("Advocate") || t.startsWith("Adv")) {
            advocates.push({ name: t.replace(/^Advocate[- ]*/, ""), role: "respondent_advocate" });
          } else {
            parties.push({ name: t, role: "respondent" });
          }
        }
      });
    }
  }

  // Case History (hearings)
  const hearings: CaseResult["hearings"] = [];
  $("table").each((_, tbl) => {
    const headers = $(tbl).find("th").map((_, el) => $(el).text().trim()).get();
    if (headers.some(h => h.includes("Hearing Date") || h.includes("Business on Date"))) {
      $(tbl).find("tr").slice(1).each((_, row) => {
        const cols = $(row).find("td");
        const causeListType = cols.eq(0).text().trim();
        const judge = cols.eq(1).text().trim();
        const businessDate = cols.eq(2).text().trim();
        const hearingDate = cols.eq(3).text().trim();
        const purpose = cols.eq(4).text().trim();
        const date = hearingDate || businessDate;
        if (date) hearings.push({ date, purpose, judge, nextDate: hearingDate });
      });
    }
  });

  // Document Details
  const documents: CaseResult["documents"] = [];
  $("table").each((_, tbl) => {
    const headers = $(tbl).find("th").map((_, el) => $(el).text().trim()).get();
    if (headers.some(h => h.includes("Document No") || h.includes("Document Filed"))) {
      $(tbl).find("tr").slice(1).each((_, row) => {
        const cols = $(row).find("td");
        const docNo = cols.eq(1).text().trim();
        const date = cols.eq(2).text().trim();
        const filedBy = cols.eq(3).text().trim();
        const docType = cols.eq(5).text().trim();
        const href = $(row).find("a").attr("href");
        if (docNo) documents.push({ id: docNo, date, type: docType || filedBy, url: href });
      });
    }
  });

  // Acts
  const acts: string[] = [];
  $("table").each((_, tbl) => {
    const headers = $(tbl).find("th").map((_, el) => $(el).text().trim()).get();
    if (headers.some(h => h.includes("Under Act") || h.includes("Under Section"))) {
      $(tbl).find("tr").slice(1).each((_, row) => {
        const actName = $(row).find("td").eq(0).text().trim();
        const sections = $(row).find("td").eq(1).text().trim();
        if (actName) acts.push(sections ? `${actName} s.${sections}` : actName);
      });
    }
  });

  console.log(`[hcservices/cnr] parsed: filingNo="${filingNumber}" cnr="${cnr}" stage="${caseStage}" parties=${parties.length} hearings=${hearings.length}`);

  return {
    caseType,
    caseNumber: registrationNumber || filingNumber,
    filingNumber,
    filingDate,
    cnr,
    status: caseStage || status,
    nextDate: nextHearingDate,
    court: court,
    judge,
    parties,
    advocates,
    hearings,
    documents,
    acts,
    dataSource: "hcservices.ecourts.gov.in",
    tier,
  };
}

function parseHcServicesCase(html: string, tier: Tier, bench: string): CaseResult {
  const court = HC_BENCHES[bench] ?? bench;

  // The AJAX response from filling_no_qry.php is a tilde-delimited list
  // Format per row: internalId~caseNo~parties~cnr~distCode~courtCode~courtName~bizId~status~hash
  // Rows are separated by ##
  if (html.includes("~") && html.includes("##")) {
    const rows = html.split("##").map(r => r.trim()).filter(Boolean);
    const parties: CaseResult["parties"] = [];
    let caseNumber = "";
    let caseType = "";
    let cnr = "";
    let status = "";
    let courtName = court;

    for (const row of rows) {
      const fields = row.split("~");
      if (fields.length < 9) continue;

      const rowCaseNo = fields[1]?.trim() ?? "";
      const rowParties = stripHtml(fields[2] ?? "");
      const rowCnr = fields[3]?.trim() ?? "";
      const rowCourtName = fields[6]?.trim() ?? "";
      const rowStatus = stripHtml(fields[8] ?? "");

      // Use the first valid row (they're all from the same filing number query)
      if (!caseNumber && rowCaseNo) {
        caseNumber = rowCaseNo;
        cnr = rowCnr;
        status = rowStatus;
        if (rowCourtName) courtName = rowCourtName;

        // Parse case type from "WP/11211/2026" → caseType="WP"
        const typeMatch = rowCaseNo.match(/^([A-Z][A-Z.]*)\s*[/\s]/);
        caseType = typeMatch?.[1] ?? "";
      }

      // Parse parties: "GEETHA<br>Versus<br>STATE OF KARNATAKA"
      // Split on "Versus" (case-insensitive)
      const versusIdx = rowParties.search(/versus/i);
      if (versusIdx >= 0) {
        const petName = rowParties.slice(0, versusIdx).trim();
        const respName = rowParties.slice(versusIdx + 6).trim();
        if (petName && !parties.find(p => p.name === petName && p.role === "petitioner")) {
          parties.push({ name: petName, role: "petitioner" });
        }
        if (respName && !parties.find(p => p.name === respName && p.role === "respondent")) {
          parties.push({ name: respName, role: "respondent" });
        }
      } else if (rowParties) {
        parties.push({ name: rowParties, role: "petitioner" });
      }
    }

    console.log(`[hcservices] parsed ${rows.length} rows from delimited response: caseNumber="${caseNumber}" status="${status}" cnr="${cnr}"`);

    return {
      caseType,
      caseNumber,
      cnr,
      status,
      court: courtName,
      parties,
      advocates: [],
      hearings: [],
      documents: [],
      dataSource: "hcservices.ecourts.gov.in",
      tier,
    };
  }

  // Fallback: try Cheerio for HTML table responses
  const $ = cheerio.load(html);

  const caseType = $("td:contains('Case Type')").next().text().trim() || $(".case_type").text().trim();
  const caseNumber = $("td:contains('Case No')").next().text().trim()
    || $("td:contains('Case Number')").next().text().trim();
  const cnr = $("td:contains('CNR Number')").next().text().trim()
    || $("td:contains('CINO')").next().text().trim();
  const filingNumber = $("td:contains('Filing Number')").next().text().trim();
  const filingDate = $("td:contains('Filing Date')").next().text().trim()
    || $("td:contains('Date of Filing')").next().text().trim();
  const status = $("td:contains('Case Status')").next().text().trim()
    || $("td:contains('Status')").next().text().trim();
  const nextDate = $("td:contains('Next Date')").next().text().trim()
    || $("td:contains('Next Hearing Date')").next().text().trim();
  const judge = $("td:contains('Coram')").next().text().trim()
    || $("td:contains('Judge')").next().text().trim();

  const parties: CaseResult["parties"] = [];
  $("table.Petitioner_Advocate_table tr, .petitioner_table tr").each((_, row) => {
    const name = $(row).find("td").first().text().trim();
    if (name) parties.push({ name, role: "petitioner" });
  });
  $("table.Respondent_Advocate_table tr, .respondent_table tr").each((_, row) => {
    const name = $(row).find("td").first().text().trim();
    if (name) parties.push({ name, role: "respondent" });
  });

  const advocates: CaseResult["advocates"] = [];
  $("td:contains('Advocate')").next().each((_, el) => {
    const name = $(el).text().trim();
    if (name) advocates.push({ name, role: "advocate" });
  });

  const hearings: CaseResult["hearings"] = [];
  $("table#historyTable tr, table.history_table tr").slice(1).each((_, row) => {
    const cols = $(row).find("td");
    const date = cols.eq(0).text().trim();
    const purpose = cols.eq(1).text().trim();
    const nextHearingDate = cols.eq(2).text().trim();
    const judge = cols.eq(3).text().trim();
    if (date) hearings.push({ date, purpose, nextDate: nextHearingDate, judge });
  });

  const documents: CaseResult["documents"] = [];
  $("a[href*='.pdf'], a[href*='order'], a[href*='judgment']").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href) documents.push({ type: "order", url: href, date: text });
  });

  return {
    caseType,
    caseNumber,
    cnr,
    filingNumber,
    filingDate,
    status,
    nextDate,
    court,
    judge,
    parties,
    advocates,
    hearings,
    documents,
    dataSource: "hcservices.ecourts.gov.in",
    tier,
  };
}
