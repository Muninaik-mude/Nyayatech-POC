import * as cheerio from "cheerio";
import { SearchInput, CaseResult, Document, Hearing, Tier } from "../core/types.js";
import { fetchWithTier, fetchImageBytes, FetchWithTierResult } from "../core/tiers.js";
import { solve, markLastAttemptAccepted } from "../core/captcha.js";
import { savePdf } from "../core/snapshot.js";

const BASE = "https://csis.tshc.gov.in";

export interface CsisTsConnectorResult {
  caseResult: CaseResult;
  rawHtml: string;
  escalations: FetchWithTierResult["escalations"];
  tier: Tier;
  durationMs: number;
  bytes: number;
  captchaAttempts: number;
  fieldsOnlyInDeep: string[];
}

export async function csisTsSearch(
  input: SearchInput,
  quickResult?: CaseResult,
  runId?: string,
  runsDir?: string,
  forceTier?: Tier
): Promise<CsisTsConnectorResult> {
  const start = Date.now();
  let captchaAttempts = 0;

  // TS HC uses image-text captcha — accept any non-empty response
  const sessionResult = await fetchWithTier(
    { url: `${BASE}/`, method: "GET" },
    (html) => html.length > 200,
    forceTier
  );

  const $session = cheerio.load(sessionResult.html);
  const captchaImgSrc = $session("img[src*='captcha'], img#captcha").attr("src");

  let searchResult: FetchWithTierResult | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    captchaAttempts++;

    let captchaSolution = "0000";
    if (captchaImgSrc) {
      const captchaUrl = captchaImgSrc.startsWith("http") ? captchaImgSrc : `${BASE}/${captchaImgSrc.replace(/^\//, "")}`;
      const { bytes, mediaType } = await fetchImageBytes(captchaUrl);
      captchaSolution = await solve(bytes.toString("base64"), "text", mediaType);
    }

    const formData: Record<string, string> = {
      captcha: captchaSolution,
    };

    if (input.searchBy === "filing" && input.filingNumber) {
      formData["filing_no"] = input.filingNumber;
      formData["filing_year"] = input.year ?? "";
    } else if (input.cnr) {
      formData["cino"] = input.cnr;
    } else {
      formData["case_type"] = input.caseType ?? quickResult?.caseType ?? "";
      formData["case_no"] = input.caseNumber ?? quickResult?.caseNumber ?? "";
      formData["case_year"] = input.year ?? quickResult?.year ?? "";
    }

    try {
      searchResult = await fetchWithTier(
        { url: `${BASE}/case_search.php`, method: "POST", body: formData },
        (html) => html.includes("Case Details") || html.includes("order"),
        forceTier
      );
      markLastAttemptAccepted(true);
      break;
    } catch {
      markLastAttemptAccepted(false);
    }
  }

  if (!searchResult) {
    throw new Error("TS HC deep search failed: captcha not solved after 3 attempts");
  }

  const { caseResult, documents } = await parseCsisTsCase(searchResult.html, searchResult.tier, runId, runsDir, forceTier);
  caseResult.documents = documents;

  const fieldsOnlyInDeep = quickResult ? diffFields(quickResult, caseResult) : [];

  return {
    caseResult,
    rawHtml: searchResult.html,
    escalations: searchResult.escalations,
    tier: searchResult.tier,
    durationMs: Date.now() - start,
    bytes: searchResult.bytes,
    captchaAttempts,
    fieldsOnlyInDeep,
  };
}

async function parseCsisTsCase(
  html: string,
  tier: Tier,
  runId?: string,
  runsDir?: string,
  forceTier?: Tier
): Promise<{ caseResult: CaseResult; documents: Document[] }> {
  const $ = cheerio.load(html);

  const caseType = $("td:contains('Case Type')").next().text().trim();
  const caseNumber = $("td:contains('Case No')").next().text().trim();
  const cnr = $("td:contains('CNR')").next().text().trim();
  const filingNumber = $("td:contains('Filing Number')").next().text().trim();
  const filingDate = $("td:contains('Filing Date')").next().text().trim();
  const status = $("td:contains('Status')").next().text().trim();
  const nextDate = $("td:contains('Next Date')").next().text().trim();
  const judge = $("td:contains('Coram')").next().text().trim() || $("td:contains('Judge')").next().text().trim();

  const parties: CaseResult["parties"] = [];
  $(".petitioner_name, td.petitioner").each((_, el) => {
    const name = $(el).text().trim();
    if (name) parties.push({ name, role: "petitioner" });
  });
  $(".respondent_name, td.respondent").each((_, el) => {
    const name = $(el).text().trim();
    if (name) parties.push({ name, role: "respondent" });
  });

  const advocates: CaseResult["advocates"] = [];
  $(".advocate_name, td.advocate").each((_, el) => {
    const name = $(el).text().trim();
    if (name) advocates.push({ name, role: "advocate" });
  });

  const hearings: Hearing[] = [];
  $("table.hearing_table tr, table#hearingTable tr").slice(1).each((_, row) => {
    const cols = $(row).find("td");
    const date = cols.eq(0).text().trim();
    const purpose = cols.eq(1).text().trim();
    const nextHearingDate = cols.eq(2).text().trim();
    const judge = cols.eq(3).text().trim();
    if (date) hearings.push({ date, purpose, nextDate: nextHearingDate, judge });
  });

  const documents: Document[] = [];
  const pdfLinks: { href: string; date: string }[] = [];
  $("a[href*='.pdf'], a[href*='order'], a[href*='judgment']").each((_, el) => {
    const href = $(el).attr("href");
    const date = $(el).closest("tr").find("td").first().text().trim();
    if (href) pdfLinks.push({ href, date });
  });

  for (const { href, date } of pdfLinks) {
    const pdfUrl = href.startsWith("http") ? href : `${BASE}/${href.replace(/^\//, "")}`;
    try {
      const pdfResult = await fetchWithTier({ url: pdfUrl }, undefined, forceTier);
      let localPath: string | undefined;
      if (runId && runsDir) {
        const pdfBuffer = Buffer.from(pdfResult.html);
        const docName = `order_${date.replace(/\//g, "-")}_${Date.now()}`;
        localPath = await savePdf(runId, docName, pdfBuffer, runsDir);
      }
      documents.push({ type: "order", url: pdfUrl, date, localPath });
    } catch {
      documents.push({ type: "order", url: pdfUrl, date });
    }
  }

  return {
    caseResult: {
      caseType,
      caseNumber,
      cnr,
      filingNumber,
      filingDate,
      status,
      nextDate,
      court: "Telangana High Court",
      judge,
      parties,
      advocates,
      hearings,
      documents,
      dataSource: "csis.tshc.gov.in",
      tier,
    },
    documents,
  };
}

function diffFields(quick: CaseResult, deep: CaseResult): string[] {
  const onlyInDeep: string[] = [];
  const keys = Object.keys(deep) as (keyof CaseResult)[];
  for (const key of keys) {
    if (key === "dataSource" || key === "tier") continue;
    const qv = quick[key];
    const dv = deep[key];
    if (!qv && dv && (typeof dv !== "object" || (Array.isArray(dv) && dv.length > 0))) {
      onlyInDeep.push(key);
    }
  }
  return onlyInDeep;
}
