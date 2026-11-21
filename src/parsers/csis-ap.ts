// AP High Court CSIS (https://digi-courts.aphc.ap.gov.in/csis_ap/).
//
// Verified against a real response (fixtures/csis-ap/AS-682-2026.b64, captured live 2026-11-21).
// Protocol: getCaseDetails.action returns base64 of a JSON array. Fields still of unknown shape
// (orders, USR, connected cases — all empty or unclear in the sample) are kept in courtData.
import type { CaseResult, Tier } from "../core/types.js";
import { toIsoDate, normaliseCnr, splitCaseNumber, withContentHash } from "./hcservices-case.js";

// Fields the portal's own JS reads from each record (all strings).
export const AP_BASE = "https://digi-courts.aphc.ap.gov.in/csis_ap";

export interface ApCsisRecord {
  cino?: string; maincasenum?: string; srcasenum?: string;
  petitioner?: string; respondent?: string; petitioneradv?: string; respondentadv?: string;
  naturecd?: string; district?: string; filingdate?: string; registrationdate?: string;
  nexthdate?: string; pdrstatus?: string; dispdate?: string; disptype?: string;
  purname?: string; judname?: string; scrutinyofcname?: string; postingstage?: string;
  subject?: string; subject1?: string; subject2?: string;
  prayer?: string; usrdetails?: unknown[]; mpdetails?: unknown; iasrdetails?: unknown; lcdetails?: unknown;
  petdetails?: unknown; resdetails?: unknown; orderdetails?: unknown; digiorders?: unknown; vakalathdetails?: unknown;
  error?: string;
}

export type ApDecode =
  | { ok: true; records: ApCsisRecord[] }
  | { ok: false; reason: string };

// The portal answers with base64 of a JSON array. "[]" = nothing found. A record with
// error != "-" carries a message (e.g. a rejected captcha) — the portal's JS alerts it.
export function decodeApResponse(body: string): ApDecode {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, reason: "empty response" };
  let json: string;
  try {
    json = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "response is not base64" };
  }
  let data: unknown;
  try { data = JSON.parse(json); } catch { return { ok: false, reason: `response is not JSON: ${trimmed.slice(0, 60)}` }; }
  if (!Array.isArray(data)) return { ok: false, reason: "response is not a JSON array" };
  if (data.length === 0) return { ok: false, reason: "no details found (empty result, or the captcha was rejected)" };
  const records = data as ApCsisRecord[];
  const err = records.find((r) => r.error && r.error !== "-");
  if (err) return { ok: false, reason: `portal error: ${err.error}` };
  return { ok: true, records };
}

const blank = (s?: string): string | undefined => {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v && v !== "-" && v.toLowerCase() !== "null" ? v : undefined;
};
// The portal uses 01/01/1900 and 01/01/5000 as "no date".
const portalDate = (s?: string): string | undefined => (/^01\/01\/(1900|5000)$/.test((s ?? "").trim()) ? undefined : toIsoDate(s));
const stripTags = (s?: string): string | undefined => blank((s ?? "").replace(/<[^>]*>/g, " "));

const asStr = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

export function parseApCsisRecord(raw: ApCsisRecord, opts: { tier: Tier }): CaseResult {
  const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, asStr(v)])) as ApCsisRecord;
  const list = <T extends Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]).filter((x) => x && typeof x === "object") : []);
  const f = (v: unknown) => blank(asStr(v));
  const numbering = splitCaseNumber((r.maincasenum ?? "").replace(/\s+/g, " ").replace(/^(\S+)\s+(\d+\/\d{4})$/, "$1 /$2"));
  const disposed = (r.pdrstatus ?? "").trim().toUpperCase() === "DISPOSED";
  const courtData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    purpose: r.purname, scrutinyOfficer: r.scrutinyofcname, postingStage: stripTags(r.postingstage),
    subject: r.subject, subject1: r.subject1, subject2: r.subject2,
  })) { const b = blank(v as string); if (b) courtData[k] = b; }

  const parties = [
    blank(r.petitioner) && { name: blank(r.petitioner)!, role: "petitioner", advocate: blank(r.petitioneradv) },
    blank(r.respondent) && { name: blank(r.respondent)!, role: "respondent", advocate: blank(r.respondentadv) },
  ].filter(Boolean) as CaseResult["parties"];

  // Real response (fixtures/csis-ap): petdetails/resdetails carry numbered parties with addresses.
  const numbered = (rows: Record<string, unknown>[], no: string, name: string, role: string, adv?: string) =>
    rows.map((x) => ({ name: f(x[name]) ?? "", role, partyNo: parseInt(asStr(x[no]), 10) || undefined, advocate: adv })).filter((p) => p.name);
  const pet = numbered(list(raw.petdetails), "psno", "pname", "petitioner", blank(r.petitioneradv));
  const res = numbered(list(raw.resdetails), "rsno", "rname", "respondent", blank(r.respondentadv));
  if (pet.length || res.length) parties.splice(0, parties.length, ...pet, ...res);
  const addresses = [...list(raw.petdetails).map((x) => ({ party: f(x.pname), address: f(x.address) })), ...list(raw.resdetails).map((x) => ({ party: f(x.rname), address: f(x.address) }))].filter((a) => a.party && a.address);
  if (addresses.length) courtData.partyAddresses = addresses; // PII: handle with care
  if (blank(r.prayer)) courtData.prayer = blank(r.prayer);
  for (const k of ["usrdetails", "digiorders", "condetails", "vakalathdetails1"] as const) {
    const v = list((raw as any)[k]);
    if (v.length) courtData[k] = v; // shape not yet understood well enough to model
  }
  const iaApplications = [
    ...list(raw.mpdetails).map((x) => ({ number: f(x.mpcasenum) ?? "", classification: f(x.papertype), party: f(x.advname), filingDate: toIsoDate(f(x.dateofiafiling)), status: f(x.order) })),
    ...list(raw.iasrdetails).map((x) => ({ number: f(x.iasrnum) ?? "", classification: f(x.iasrtype), party: f(x.iasradv), filingDate: toIsoDate(f(x.iasrdate)), status: f(x.iasrstatus) })),
  ].filter((a) => a.number);
  const lowerCourts = list(raw.lcdetails).map((x) => ({ courtName: f(x.lccourt), caseNumber: f(x.eanum), decisionDate: toIsoDate(f(x.lcjudgedate)), district: f(x.lcdist) }));
  if (list(raw.lcdetails).some((x) => f(x.lcjudge))) courtData.lowerCourtJudges = list(raw.lcdetails).map((x) => f(x.lcjudge));

  // orderdetails rows: {caseno, orderno, docuname, judgename, orderdt:"YYYY-MM-DD"}. The response gives no PDF link, so no URL is invented.
  const orders = list(raw.orderdetails).map((x) => {
    const title = f(x.docuname) ?? "";
    const orderno = f(x.orderno) ?? "";
    // Portal's own "View" link: POST sdcorderpdf.action {year: CNR[12:16], fname: orderno, otype: doctype}
    const fileRequest = orderno && r.cino ? { url: `${AP_BASE}/sdcorderpdf.action`, form: { year: r.cino.slice(12, 16), fname: orderno, otype: f(x.doctype) ?? "" } } : undefined;
    return { number: orderno, fileRequest, title: title || undefined, orderOn: f(x.caseno), judge: f(x.judgename), date: toIsoDate(f(x.orderdt)),
      type: (/interim/i.test(title) ? "interim_order" : /final|judg/i.test(title) ? "judgment" : "order") as "order" | "interim_order" | "judgment" };
  }).filter((o) => o.number);
  // digiorders: e-signed orders. Portal's "View": POST sdceorderpdf.action {cino, fname: oname, otype}
  const digiOrders = list(raw.digiorders).map((x) => ({
    number: f(x.oname) ?? "", title: f(x.otype), orderOn: blank(r.maincasenum), date: toIsoDate(f(x.odate)),
    type: (/interim/i.test(asStr(x.otype)) ? "interim_order" : /final|judg/i.test(asStr(x.otype)) ? "judgment" : "order") as "order" | "interim_order" | "judgment",
    fileRequest: r.cino && f(x.oname) ? { url: `${AP_BASE}/sdceorderpdf.action`, form: { cino: r.cino, fname: f(x.oname)!, otype: f(x.otype) ?? "" } } : undefined,
  })).filter((o) => o.number);
  delete courtData.digiorders; // modelled above, no longer a passthrough
  // vakalathdetails: {vaktype:"2(R)"|"1(P)", advcd: bar code, advname} — which party an advocate acts for.
  const vakalath = list(raw.vakalathdetails).map((x) => ({ name: f(x.advname) ?? "", type: f(x.vaktype) ?? "", code: f(x.advcd) })).filter((v) => v.name);
  const vakAdvocates = vakalath.map((v) => ({ name: v.name, role: /\(R\)/i.test(v.type) ? "respondent_advocate" : /\(P\)/i.test(v.type) ? "petitioner_advocate" : "advocate", forParties: [] as string[], barCode: v.code }));

  const next = portalDate(r.nexthdate);
  return withContentHash({
    cnr: r.cino ? normaliseCnr(r.cino) : undefined,
    caseType: numbering.type, caseNumber: numbering.number ?? blank(r.maincasenum), year: numbering.year,
    registrationNumber: blank(r.maincasenum),
    filingNumber: blank(r.srcasenum),
    filingDate: blank(r.filingdate),
    registrationDate: toIsoDate(r.registrationdate),
    court: "Andhra Pradesh High Court", benchCode: "APHC", district: blank(r.district),
    status: blank(r.pdrstatus) ?? "Pending",
    decisionDate: disposed ? toIsoDate(r.dispdate) : undefined,
    natureOfDisposal: disposed ? blank(r.disptype) : undefined,
    nextHearingDate: next, nextDate: next,
    category: blank(r.naturecd) ? { name: blank(r.naturecd)! } : undefined,
    judge: blank(r.judname),
    parties,
    // Advocate strings are kept verbatim: how several advocates are separated is unknown until a real sample exists.
    advocates: [
      blank(r.petitioneradv) && { name: blank(r.petitioneradv)!, role: "petitioner_advocate", forParties: blank(r.petitioner) ? [blank(r.petitioner)!] : [] },
      blank(r.respondentadv) && { name: blank(r.respondentadv)!, role: "respondent_advocate", forParties: blank(r.respondent) ? [blank(r.respondent)!] : [] },
    ].filter(Boolean).concat(vakAdvocates.filter((v) => !(blank(r.petitioneradv) ?? blank(r.respondentadv) ?? "").includes(v.name))) as CaseResult["advocates"],
    hearings: [], documents: [], orders: [...orders, ...digiOrders], iaApplications, lowerCourts,
    courtData: Object.keys(courtData).length ? courtData : undefined,
    fetchedAt: new Date().toISOString(),
    dataSource: "digi-courts.aphc.ap.gov.in/csis_ap",
    tier: opts.tier,
  });
}
