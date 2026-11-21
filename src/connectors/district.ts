import * as cheerio from "cheerio";
import { SearchInput, CaseResult, Tier } from "../core/types.js";
import { fetchWithTier, fetchImageBytes, FetchWithTierResult } from "../core/tiers.js";
import { withCaptchaRetries } from "../core/captcha-loop.js";
import { solve, CaptchaTracker } from "../core/captcha.js";

const BASE = "https://services.ecourts.gov.in/ecourtindia_v6";

// The home page's captcha is <img id="captcha_image" src="/ecourtindia_v6/vendor/securimage/securimage_show.php?HASH">.
// The src is root-relative and already contains /ecourtindia_v6, so it must be resolved against the ORIGIN —
// joining it onto BASE produced .../ecourtindia_v6/ecourtindia_v6/vendor/... (a 404).
export function findCaptchaUrl(html: string): string | undefined {
  const $ = cheerio.load(html);
  const src = $("img#captcha_image").attr("src") ?? $("img[src*='securimage_show']").attr("src") ?? $("img[src*='captcha']").attr("src");
  return src ? new URL(src, `${BASE}/`).toString() : undefined;
}

export interface DistrictConnectorResult {
  caseResult: CaseResult;
  rawHtml: string;
  escalations: FetchWithTierResult["escalations"];
  tier: Tier;
  durationMs: number;
  bytes: number;
  captchaAttempts: number;
  captchaSolves: number;
}

export async function districtSearch(input: SearchInput, forceTier?: Tier): Promise<DistrictConnectorResult> {
  const start = Date.now();
  const tracker = new CaptchaTracker();

  // Shared cookie jar — PHPSESSID must carry across session, captcha, and form POST
  const cookieJar = new Map<string, string>();

  const searchResult = await withCaptchaRetries<FetchWithTierResult>({
    tracker,
    maxAttempts: 3,
    label: "District search",
    attempt: async () => {
      // Fresh session page each attempt so the captcha matches the session being submitted
      const session = await fetchWithTier({ url: `${BASE}/`, method: "GET", cookieJar }, (html) => html.length > 200, forceTier);
      const captchaUrl = findCaptchaUrl(session.html);
      if (!captchaUrl) throw new Error("no captcha image found on the page (portal layout changed?)");
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl, cookieJar);
      const captchaSolution = await solve(bytes.toString("base64"), "text", mediaType, tracker);

      const formData: Record<string, string> = { captcha: captchaSolution };
      if (input.searchBy === "cnr" && input.cnr) {
        formData["cino"] = input.cnr;
      } else if (input.searchBy === "case") {
        formData["state_code"] = input.state ?? "";
        formData["dist_code"] = input.district ?? "";
        formData["court_code"] = input.complex ?? "";
        formData["case_type"] = input.caseType ?? "";
        formData["case_no"] = input.caseNumber ?? "";
        formData["rgyear"] = input.year ?? "";
      } else if (input.searchBy === "filing") {
        formData["filing_no"] = input.filingNumber ?? "";
        formData["rgyear"] = input.year ?? "";
      }

      return fetchWithTier(
        { url: `${BASE}/index.php`, method: "POST", body: formData, cookieJar },
        // Strict: the old check also accepted any page containing "cino" or "case_no" —
        // which is the search form itself, so a rejected captcha counted as success.
        (html) => html.includes("Case Details"),
        "http" // session-bound captcha: browser tiers would not carry the cookie jar
      );
    },
  });

  const caseResult = parseDistrictCase(searchResult.html, searchResult.tier);
  // No fixture proves this flow works against the real v6 portal (multi-step AJAX with tokens).
  caseResult.warnings = ["district connector is UNVERIFIED: request flow and selectors are guesses, no saved real response"];

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

function parseDistrictCase(html: string, tier: Tier): CaseResult {
  const $ = cheerio.load(html);

  const caseType = $("td:contains('Case Type')").next().text().trim() || $(".case_type").text().trim();
  const caseNumber = $("td:contains('Case No')").next().text().trim();
  const cnr = $("td:contains('CNR Number')").next().text().trim() || $(".cnr_no").text().trim();
  const filingDate = $("td:contains('Filing Date')").next().text().trim();
  const status = $("td:contains('Case Status')").next().text().trim() || $(".case_status").text().trim();
  const nextDate = $("td:contains('Next Date')").next().text().trim() || $(".next_date").text().trim();
  const court = $("td:contains('Court Name')").next().text().trim() || $("td:contains('Court No')").next().text().trim();
  const judge = $("td:contains('Judge Name')").next().text().trim() || $(".judge_name").text().trim();

  const parties: CaseResult["parties"] = [];
  $("table.Petitioner_Advocate_table tr, table.petitioner_table tr").each((_, row) => {
    const name = $(row).find("td").first().text().trim();
    if (name) parties.push({ name, role: "petitioner" });
  });
  $("table.Respondent_Advocate_table tr, table.respondent_table tr").each((_, row) => {
    const name = $(row).find("td").first().text().trim();
    if (name) parties.push({ name, role: "respondent" });
  });

  const advocates: CaseResult["advocates"] = [];
  $("table.Petitioner_Advocate_table tr").each((_, row) => {
    const advName = $(row).find("td").eq(1).text().trim();
    if (advName) advocates.push({ name: advName, role: "advocate" });
  });

  const hearings: CaseResult["hearings"] = [];
  $("table.history_table tr, table#historyTable tr").slice(1).each((_, row) => {
    const cols = $(row).find("td");
    const date = cols.eq(0).text().trim();
    const purpose = cols.eq(1).text().trim();
    const nextHearingDate = cols.eq(2).text().trim();
    if (date) hearings.push({ date, purpose, nextDate: nextHearingDate });
  });

  const documents: CaseResult["documents"] = [];
  $("table.order_table tr, a[href*='.pdf'], a[href*='order']").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href) documents.push({ type: "order", url: href, date: text });
  });

  const acts: string[] = [];
  $("td:contains('Acts')").next().find("li, td").each((_, el) => {
    const act = $(el).text().trim();
    if (act) acts.push(act);
  });

  return {
    caseType,
    caseNumber,
    cnr,
    filingDate,
    status,
    nextDate,
    court,
    judge,
    parties,
    advocates,
    acts,
    hearings,
    documents,
    dataSource: "services.ecourts.gov.in",
    tier,
  };
}
