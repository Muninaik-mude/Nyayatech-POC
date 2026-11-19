import * as cheerio from "cheerio";
import { SearchInput, CaseResult, Tier } from "../core/types.js";
import { fetchWithTier, fetchImageBytes, FetchWithTierResult } from "../core/tiers.js";
import { solve, markLastAttemptAccepted } from "../core/captcha.js";

const BASE = "https://services.ecourts.gov.in/ecourtindia_v6";

export interface DistrictConnectorResult {
  caseResult: CaseResult;
  rawHtml: string;
  escalations: FetchWithTierResult["escalations"];
  tier: Tier;
  durationMs: number;
  bytes: number;
  captchaAttempts: number;
}

export async function districtSearch(input: SearchInput, forceTier?: Tier): Promise<DistrictConnectorResult> {
  const start = Date.now();
  let captchaAttempts = 0;

  // Shared cookie jar — PHPSESSID must carry across session, captcha, and form POST
  const cookieJar = new Map<string, string>();

  // Step 1: Get session and captcha
  const sessionResult = await fetchWithTier(
    { url: `${BASE}/`, method: "GET", cookieJar },
    (html) => html.length > 200,
    forceTier
  );

  // Extract captcha image URL from session page
  const $ = cheerio.load(sessionResult.html);
  const captchaImgSrc = $("img[src*='captcha']").attr("src") ?? $("img#captcha_image").attr("src");

  let searchResult: FetchWithTierResult | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    captchaAttempts++;

    let captchaSolution = "0000";
    if (captchaImgSrc) {
      const captchaUrl = captchaImgSrc.startsWith("http") ? captchaImgSrc : `${BASE}/${captchaImgSrc.replace(/^\//, "")}`;
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl, cookieJar);
      captchaSolution = await solve(bytes.toString("base64"), "text", mediaType);
    }

    const formData: Record<string, string> = {
      captcha: captchaSolution,
    };

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

    try {
      searchResult = await fetchWithTier(
        { url: `${BASE}/index.php`, method: "POST", body: formData, cookieJar },
        (html) => html.includes("Case Details") || html.includes("cino") || html.includes("case_no"),
        forceTier
      );
      markLastAttemptAccepted(true);
      break;
    } catch {
      markLastAttemptAccepted(false);
    }
  }

  if (!searchResult) {
    throw new Error("District search failed: captcha not solved after 3 attempts");
  }

  const caseResult = parseDistrictCase(searchResult.html, searchResult.tier);

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
