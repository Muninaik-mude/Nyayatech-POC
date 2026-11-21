// Parsers for hcservices.ecourts.gov.in responses. Every selector here was written against a
// real saved page in fixtures/hcservices/ — do not add a selector without a fixture that has it.
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import type { CaseResult, Tier, Party, Advocate, Hearing, Document, Classification } from "../core/types.js";

export const HC_NEW_BASE = "https://hcservices.ecourts.gov.in/hcservices";

type $ = cheerio.CheerioAPI;
type El = Parameters<$>[0];

// ---------- small helpers ----------

const clean = (s?: string | null): string => (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const blankToUndef = (s?: string): string | undefined => {
  const v = clean(s);
  return v && !/^-+$/.test(v) ? v : undefined;
};

// CNR: upper-case, no dashes. "HBHC01-103220-2017" -> "HBHC011032202017"
export function normaliseCnr(cnr: string): string {
  return cnr.trim().toUpperCase().replace(/-/g, "");
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// "27-12-2017" | "27/12/2017" | "28th March 2024" | "2024-03-28"  ->  "YYYY-MM-DD"; "" / "--" / junk -> undefined
export function toIsoDate(raw?: string | null): string | undefined {
  const s = clean(raw);
  if (!s || /^-+$/.test(s)) return undefined;
  let d: number, m: number, y: number;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/))) {
    d = +r[1]; m = MONTHS[r[2].slice(0, 3).toLowerCase()] ?? 0; y = +r[3];
  } else return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// "WP(C) /31129/2026" -> { type: "WP(C)", number: "31129", year: "2026" }
export function splitCaseNumber(raw: string): { type?: string; number?: string; year?: string } {
  const m = clean(raw).match(/^(.+?)\s*\/\s*(\d+)\s*\/\s*(\d{4})$/);
  return m ? { type: m[1].trim(), number: m[2], year: m[3] } : {};
}

// "SPECIFIC PERFORMANCE ( 3 )" -> { name: "SPECIFIC PERFORMANCE", code: "3" }
function toClassification(raw?: string): Classification | undefined {
  const v = clean(raw);
  if (!v) return undefined;
  const m = v.match(/^(.*?)\s*\(\s*([^)]+?)\s*\)$/);
  return m ? { name: m[1].trim(), code: m[2].trim() } : { name: v };
}

// Text of an element with <br> turned into newlines
function textWithBreaks($: $, el: El): string {
  const copy = $(el).clone();
  copy.find("br").replaceWith("\n");
  return copy.text();
}

// Label/value pairs from a table whose rows are [label, value] or [label, value, label, value]
function tablePairs($: $, table: El): [string, string][] {
  const out: [string, string][] = [];
  $(table).find("tr").each((_, tr) => {
    const cells = $(tr).children("td,th").toArray();
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = clean($(cells[i]).text()).replace(/\s*:\s*$/, "");
      if (key) out.push([key.toLowerCase(), clean($(cells[i + 1]).text())]);
    }
  });
  return out;
}

// Label/value pairs from the span-label layout: <span>Label</span><label>:&nbsp;value</label><br>
function spanPairs($: $, container: El): Record<string, string> {
  const out: Record<string, string> = {};
  $(container).children("span").each((_, sp) => {
    const key = clean($(sp).text()).replace(/\s*:\s*$/, "").toLowerCase();
    const val = clean($(sp).next("label").text()).replace(/^:\s*/, "");
    if (key) out[key] = val;
  });
  return out;
}

// ---------- section parsers ----------

function parsePartyBlock($: $, selector: string, role: "petitioner" | "respondent", unparsed: string[]): Party[] {
  const el = $(selector).first();
  if (!el.length) return [];
  const parties: Party[] = [];
  let current: Party | undefined;
  for (const raw of textWithBreaks($, el[0]).split("\n")) {
    const line = clean(raw);
    if (!line) continue;
    const pm = line.match(/^(\d+)\)\s*(.*)$/);
    if (pm) {
      current = { name: pm[2].replace(/[,;]+$/, "").trim(), role, partyNo: +pm[1], advocates: [] };
      parties.push(current);
      continue;
    }
    // Anything after a party line is that party's advocate(s). Courts differ: most prefix "Advocate-",
    // some (MP, Orissa, Madras, Tripura) give the bare name, some list several comma-separated and
    // wrap the list over <br>. The portal offers no other marker, so a wrapped party NAME would be
    // misread as an advocate — not seen in any fixture.
    const text = line.replace(/^Advocate\s*[-:]\s*/i, "");
    if (!current) { unparsed.push(line); continue; }
    for (const part of text.split(",")) {
      const name = clean(part);
      if (name && !current.advocates!.includes(name)) current.advocates!.push(name);
    }
  }
  for (const p of parties) {
    if (p.advocates!.length) p.advocate = p.advocates!.join(", ");
    else delete p.advocates;
  }
  return parties;
}

function linkAdvocates(parties: Party[]): Advocate[] {
  const byKey = new Map<string, Advocate>();
  for (const p of parties) {
    for (const name of p.advocates ?? []) {
      const role = `${p.role}_advocate`;
      const key = `${role}|${name}`;
      let a = byKey.get(key);
      if (!a) { a = { name, role, forParties: [] }; byKey.set(key, a); }
      a.forParties!.push(p.name);
    }
  }
  return [...byKey.values()];
}

// ---------- full case page (HC "new portal": cases_qry/index_qry.php) ----------

// True only for a real case-detail page — NOT for "Invalid Captcha", empty, error or captcha pages.
export function isCaseDetailPage(html: string): boolean {
  return /case_details_table/.test(html) && /CNR Number|Filing Number/.test(html);
}

export function parseHcCaseHtml(html: string, opts: { tier: Tier; bench: string; courtName?: string }): CaseResult {
  const $ = cheerio.load(html);
  const unparsed: string[] = [];
  const unmapped: Record<string, string> = {};

  // Case Details + Case Status label/value tables
  const pairs = new Map<string, string>();
  for (const sel of ["table.case_details_table", "table.table_r"]) {
    $(sel).each((_, t) => { for (const [k, v] of tablePairs($, t)) if (!pairs.has(k) || !pairs.get(k)) pairs.set(k, v); });
  }
  const used = new Set<string>();
  const get = (label: string): string => { used.add(label); return pairs.get(label) ?? ""; };

  const filingNumber = get("filing number");
  const filingDate = get("filing date");
  const registrationNumber = get("registration number");
  const registrationDate = get("registration date");
  const cnrRaw = get("cnr number");
  const stage = get("case stage");
  const caseStatusText = get("case status");
  const decisionDate = toIsoDate(get("decision date"));
  const natureOfDisposal = blankToUndef(get("nature of disposal"));
  const firstHearing = get("first hearing date");
  const nextHearing = get("next hearing date");
  const coram = get("coram");
  const benchType = get("bench type");
  const judicialBranch = get("judicial branch");
  const state = get("state");
  const district = get("district");
  for (const [k, v] of pairs) if (!used.has(k) && v) unmapped[k] = v;

  const cnr = cnrRaw ? normaliseCnr(cnrRaw) : undefined;
  const numbering = splitCaseNumber(registrationNumber || filingNumber);

  // Parties and linked advocates
  const parties = [
    ...parsePartyBlock($, ".Petitioner_Advocate_table", "petitioner", unparsed),
    ...parsePartyBlock($, ".Respondent_Advocate_table", "respondent", unparsed),
  ];

  // Acts
  const actsStructured: NonNullable<CaseResult["actsStructured"]> = [];
  $("table.Acts_table tr").slice(1).each((_, tr) => {
    const c = $(tr).children("td");
    const name = clean(c.eq(0).text());
    if (name) actsStructured.push({ name, sections: blankToUndef(c.eq(1).text()) });
  });

  // FIR
  let firDetails: CaseResult["firDetails"];
  const firEl = $(".FIR_details_table").first();
  if (firEl.length) {
    const f = spanPairs($, firEl[0]);
    firDetails = {
      state: blankToUndef(f["state"]), district: blankToUndef(f["district"]),
      policeStation: blankToUndef(f["police station"]), firNumber: blankToUndef(f["fir number"]),
      year: blankToUndef(f["year"]),
    };
  }

  // Subordinate / trial court
  const lowerCourts: NonNullable<CaseResult["lowerCourts"]> = [];
  $(".Lower_court_table").each((_, el) => {
    const f = spanPairs($, el);
    lowerCourts.push({
      courtName: blankToUndef(f["court number and name"]),
      caseNumber: blankToUndef(f["case number and year"]),
      decisionDate: toIsoDate(f["case decision date"]),
      state: blankToUndef(f["state"]), district: blankToUndef(f["district"]),
    });
  });

  // Hearings: Cause List Type | Judge | Business on Date | Hearing Date | Purpose of Hearing
  const hearings: Hearing[] = [];
  $("table.history_table tr").slice(1).each((_, tr) => {
    const c = $(tr).children("td");
    if (c.length < 5) return;
    const hearingRaw = clean(c.eq(3).text());
    const businessRaw = clean(c.eq(2).text());
    if (!hearingRaw && !businessRaw) return;
    hearings.push({
      date: hearingRaw || businessRaw,
      causeListType: blankToUndef(c.eq(0).text()),
      judge: blankToUndef(c.eq(1).text()),
      businessOnDate: toIsoDate(businessRaw),
      hearingDate: toIsoDate(hearingRaw),
      purpose: blankToUndef(c.eq(4).text()),
    });
  });

  // Orders (PDF links are relative to /hcservices/)
  const orders: NonNullable<CaseResult["orders"]> = [];
  const documents: Document[] = [];
  $("table.order_table tr").slice(1).each((_, tr) => {
    const c = $(tr).children("td");
    const number = clean(c.eq(0).text());
    if (c.length < 4 || !/\d/.test(number)) return;
    const href = $(tr).find("a[href]").first().attr("href")?.trim();
    const fileUrl = href ? new URL(href, `${HC_NEW_BASE}/`).toString() : undefined;
    const dateRaw = clean(c.eq(3).text());
    orders.push({
      number, orderOn: blankToUndef(c.eq(1).text()), judge: blankToUndef(c.eq(2).text()),
      date: toIsoDate(dateRaw), type: "order", fileUrl,
    });
    documents.push({ id: number, date: dateRaw, type: "order", url: fileUrl });
  });

  // IA / misc applications
  const iaApplications: NonNullable<CaseResult["iaApplications"]> = [];
  $("table.IAheading tr").slice(1).each((_, tr) => {
    const c = $(tr).children("td");
    if (c.length < 5) return;
    const first = clean(textWithBreaks($, c[0]).replace(/\n/g, " "));
    const cm = first.match(/^(.*?)\s*Classification\s*:\s*(.*)$/i);
    iaApplications.push({
      number: (cm ? cm[1] : first).trim(),
      classification: blankToUndef(cm?.[2]),
      party: blankToUndef(c.eq(1).text()),
      filingDate: toIsoDate(c.eq(2).text()),
      nextDate: toIsoDate(c.eq(3).text()),
      status: blankToUndef(c.eq(4).text()),
    });
  });

  // Objections: Sr.No. | Sub Category | Objection | Objection Compliance Date | Receipt Date
  const objections: NonNullable<CaseResult["objections"]> = [];
  $("table.obj_table tr").slice(1).each((_, tr) => {
    const c = $(tr).children("td");
    if (c.length < 3) return;
    objections.push({
      srNo: blankToUndef(c.eq(0).text()), subCategory: blankToUndef(c.eq(1).text()),
      objection: blankToUndef(c.eq(2).text()), complianceDate: blankToUndef(c.eq(3).text()),
      receiptDate: blankToUndef(c.eq(4).text()),
    });
  });

  // Filed documents: Sr. No. | Document No. | Date of Receiving | Filed by | Name of Advocate | Document Filed
  const filings: NonNullable<CaseResult["filings"]> = [];
  $("table.transfer_table tr").slice(1).each((_, tr) => {
    const c = $(tr).children("td");
    if (c.length < 4) return;
    filings.push({
      srNo: blankToUndef(c.eq(0).text()), documentNo: blankToUndef(c.eq(1).text()),
      receivedDate: toIsoDate(c.eq(2).text()), filedBy: blankToUndef(c.eq(3).text()),
      advocate: blankToUndef(c.eq(4).text()), documentFiled: blankToUndef(c.eq(5).text()),
    });
  });

  // Category / sub category
  let category: Classification | undefined, subCategory: Classification | undefined;
  $("#subject_table tr").each((_, tr) => {
    const c = $(tr).children("td");
    const key = clean(c.eq(0).text()).toLowerCase();
    if (key === "category") category = toClassification(c.eq(1).text());
    else if (key === "sub category") subCategory = toClassification(c.eq(1).text());
  });

  // Linked cases: Main Matters / Sub Matters
  const linkedCases: NonNullable<CaseResult["linkedCases"]> = [];
  for (const [sel, relation] of [["table.MainCase", "main"], ["table.SubCase", "sub"]] as const) {
    $(`${sel} tr`).each((_, tr) => {
      const filing = clean($(tr).children("td").eq(1).text());
      if (filing) linkedCases.push({ relation, filingNumber: filing });
    });
  }

  const courtData: Record<string, unknown> = {};
  if (Object.keys(unmapped).length) courtData.unmappedFields = unmapped;
  if (unparsed.length) courtData.unparsedPartyLines = unparsed;

  const caseResult: CaseResult = {
    sourceCaseId: cnr ? undefined : `${opts.bench}:${normaliseCnr(filingNumber || registrationNumber)}`,
    cnr,
    caseType: numbering.type,
    caseNumber: numbering.number ?? (registrationNumber || filingNumber),
    year: numbering.year,
    filingNumber: blankToUndef(filingNumber),
    filingDate: blankToUndef(filingDate),
    registrationNumber: blankToUndef(registrationNumber),
    registrationDate: toIsoDate(registrationDate),
    court: opts.courtName ?? opts.bench,
    benchCode: opts.bench,
    courtCode: cnr?.match(/^[A-Z]{4}(\d{2})/)?.[1],
    state: blankToUndef(state),
    district: blankToUndef(district),
    // Disposed pages carry an explicit "Case Status"; otherwise no decision date means pending.
    status: blankToUndef(caseStatusText) ?? (decisionDate ? "Disposed" : "Pending"),
    stage: blankToUndef(stage),
    decisionDate,
    natureOfDisposal,
    firstHearingDate: toIsoDate(firstHearing),
    nextHearingDate: toIsoDate(nextHearing),
    nextDate: blankToUndef(nextHearing),
    category,
    subCategory,
    benchType: blankToUndef(benchType),
    judicialBranch: blankToUndef(judicialBranch),
    judge: blankToUndef(coram),
    parties,
    advocates: linkAdvocates(parties),
    acts: actsStructured.map((a) => (a.sections ? `${a.name} s.${a.sections}` : a.name)),
    actsStructured,
    firDetails,
    fir: firDetails ? [firDetails.policeStation, firDetails.firNumber && `FIR ${firDetails.firNumber}`, firDetails.year].filter(Boolean).join(", ") || undefined : undefined,
    hearings,
    documents,
    orders,
    iaApplications,
    objections,
    filings,
    linkedCases,
    lowerCourts,
    courtData: Object.keys(courtData).length ? courtData : undefined,
    fetchedAt: new Date().toISOString(),
    dataSource: "hcservices.ecourts.gov.in",
    tier: opts.tier,
  };
  return withContentHash(caseResult);
}

// ---------- filing-number search list (old portal: cases/filling_no_qry.php) ----------
// Rows split by "##", fields by "~":
//   internalId~caseNo~parties~cnr~distCode~courtCode~courtName~bizId~status~hash

export function isFilingListResponse(html: string): boolean {
  return html.includes("~") && html.includes("##");
}

export function parseFilingList(html: string, opts: { tier: Tier; bench: string; courtName?: string }): CaseResult {
  const strip = (s: string) => clean(s.replace(/<[^>]+>/g, " "));
  const rows = html.split("##").map((r) => r.trim()).filter(Boolean).map((r) => r.split("~")).filter((f) => f.length >= 9);
  const toMatch = (f: string[]) => ({
    caseNumber: clean(f[1]), parties: strip(f[2]).split(/\s*versus\s*/i).map(clean),
    cnr: clean(f[3]), courtName: clean(f[6]), status: strip(f[8]),
  });
  const matches = rows.map(toMatch);
  const first = matches[0];

  const parties: Party[] = [];
  if (first) {
    if (first.parties[0]) parties.push({ name: first.parties[0], role: "petitioner" });
    if (first.parties[1]) parties.push({ name: first.parties[1], role: "respondent" });
  }
  const numbering = splitCaseNumber(first?.caseNumber ?? "");

  const caseResult: CaseResult = {
    cnr: first?.cnr ? normaliseCnr(first.cnr) : undefined,
    caseType: numbering.type ?? (first?.caseNumber.match(/^([A-Z][A-Z.()]*)\s*[/\s]/)?.[1]),
    caseNumber: numbering.number ?? first?.caseNumber,
    year: numbering.year,
    registrationNumber: first?.caseNumber,
    court: first?.courtName || opts.courtName || opts.bench,
    benchCode: opts.bench,
    status: first?.status,
    parties,
    advocates: [],
    hearings: [],
    documents: [],
    // The search can match several cases (same number, different case types) — keep the rest.
    courtData: matches.length > 1 ? { otherMatches: matches.slice(1) } : undefined,
    fetchedAt: new Date().toISOString(),
    dataSource: "hcservices.ecourts.gov.in",
    tier: opts.tier,
  };
  return withContentHash(caseResult);
}

// ---------- change detection ----------

// sha256 over the case content only (not tier / fetch time), so two refreshes of an unchanged case hash equal.
// Whole days from filing (else registration) to decision, or to `now` while pending. Undefined if no usable start date.
export function caseDurationDays(c: Pick<CaseResult, "filingDate" | "registrationDate" | "decisionDate">, now: Date = new Date()): number | undefined {
  const start = toIsoDate(c.filingDate) ?? c.registrationDate;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return undefined;
  const end = c.decisionDate && /^\d{4}-\d{2}-\d{2}$/.test(c.decisionDate) ? Date.parse(c.decisionDate) : now.getTime();
  const days = Math.floor((end - Date.parse(start)) / 86_400_000);
  return days >= 0 ? days : undefined;
}

export function withContentHash(c: CaseResult): CaseResult {
  const { tier: _t, fetchedAt: _f, contentHash: _h, warnings: _w, caseDurationDays: _d, ...content } = c;
  c = { ...c, caseDurationDays: caseDurationDays(c) };
  return { ...c, contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
}
