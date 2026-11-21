// AP High Court daily cause list (https://aphc.gov.in/Hcdbs/). Public, no captcha.
// Parsed from real pages saved in fixtures/cause-list-ap/ (court 2, 21-11-2026, 78 entries).
import * as cheerio from "cheerio";

export interface CauseListEntry {
  serial: number;
  section: string;              // e.g. "FOR ADMISSION" — the heading the row sits under
  caseNumber: string;           // "MACMA/873/2026"
  filingNumberOnly?: true;      // listed as "…/ (Filing No.)": not registered yet, so this is a filing number
  arisingFrom?: string;         // lower-court case, e.g. "MVOP/204/2023"
  applications: string[];       // "IA 1/2026", "Stay Petition"
  petitioner?: string;
  respondent?: string;
  petitionerAdvocate?: string;
  respondentAdvocate?: string;
  district?: string;
}

export interface CauseList {
  court: "APHC";
  listType: string;             // D daily, A advance, W weekly, S supplementary, P ...
  listDate: string;             // ISO
  courtNo?: string;             // "COURT NO. 2"
  judges: string[];
  hearingNote?: string;         // "To be Heard on Saturday ... (AT 10:30 AM ...)"
  title?: string;               // "(CAUSE LIST MOTION HEARING)"
  entries: CauseListEntry[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function ddmmyyyyToIso(s: string): string | undefined {
  const m = s.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined;
}

// getdates.jsp → "21-11-2026@20-11-2026@..." (padded with whitespace). "0" = none, "1"/"2" = errors.
export function parseListDates(body: string): string[] {
  const t = body.trim();
  if (!t || /^[012]$/.test(t)) return [];
  return t.split("@").map((d) => ddmmyyyyToIso(d)).filter((d): d is string => !!d);
}

// courtlist.jsp → base64 of [{court_code, court_name}]; single digits are error codes.
export function decodeCourtList(body: string): { code: string; name: string }[] {
  const t = body.trim();
  if (!t || /^\d$/.test(t)) return [];
  try {
    const arr = JSON.parse(Buffer.from(t, "base64").toString("utf8"));
    return Array.isArray(arr) ? arr.map((c: any) => ({ code: String(c.court_code), name: String(c.court_name) })) : [];
  } catch { return []; }
}

export function parseApCauseList(html: string): CauseList | undefined {
  const $ = cheerio.load(html);
  const table = $("table#clisttable");
  if (!table.length) return undefined;

  const listType = $("input#causelisttype").attr("value") ?? "";
  const listDate = ddmmyyyyToIso($("input#listdate").attr("value") ?? "");
  if (!listDate) return undefined;

  // Header rows: one <th colspan=6> each, before the column-title row.
  const headers: string[] = [];
  table.find("tr").each((_, tr) => {
    if ($(tr).find("td").length) return false; // reached data
    const th = $(tr).find("th[colspan]");
    if (th.length && !$(tr).find("a").length && !th.css("text-decoration")) headers.push(clean(th.text()));
    return undefined;
  });

  const entries: CauseListEntry[] = [];
  let section = "";
  table.find("tr").each((_, tr) => {
    const row = $(tr);
    const th = row.children("th[colspan]");
    if (th.length && !row.children("td").length) {
      if (/underline/.test(th.attr("style") ?? "")) section = clean(th.text());
      return;
    }
    const tds = row.children("td");
    if (tds.length < 6) return;
    const serial = parseInt(clean($(tds[0]).text()), 10);
    const link = $(tds[1]).find("a").first();
    const rawNumber = clean(link.text());
    const filingOnly = /\(Filing No\.\)/i.test(rawNumber);
    const caseNumber = rawNumber.replace(/\/?\s*\(Filing No\.\)/i, "").replace(/\/$/, "").trim();
    if (!Number.isFinite(serial) || !caseNumber) return;

    const cell = $(tds[1]).clone();
    cell.find("a").remove();
    const fonts = cell.find("font").toArray().map((f) => clean($(f).text()));
    const arising = fonts.find((f) => /^ARISING FROM/i.test(f));
    const arisingFrom = arising?.replace(/^ARISING FROM\s*/i, "").replace(/^\(|\)$/g, "").trim() || undefined;
    const applications = fonts.filter((f) => f && f !== arising);

    const partyHtml = ($(tds[2]).html() ?? "").split(/<br\s*\/?>\s*Vs\s*<br\s*\/?>/i);
    const text = (h?: string) => clean(cheerio.load(`<p>${h ?? ""}</p>`)("p").text()) || undefined;
    entries.push({
      serial, section, caseNumber, ...(filingOnly ? { filingNumberOnly: true as const } : {}), arisingFrom, applications,
      petitioner: text(partyHtml[0]), respondent: text(partyHtml[1]),
      petitionerAdvocate: clean($(tds[3]).text()) || undefined,
      respondentAdvocate: clean($(tds[4]).text()) || undefined,
      district: clean($(tds[5]).text()) || undefined,
    });
  });

  const courtNo = headers.find((h) => /^COURT NO/i.test(h));
  const judges = headers.filter((h) => /JUSTICE|JUDGE/i.test(h));
  return {
    court: "APHC", listType, listDate, courtNo, judges,
    hearingNote: headers.find((h) => /^To be Heard/i.test(h)),
    title: headers.find((h) => /^\(CAUSE LIST/i.test(h)),
    entries,
  };
}
