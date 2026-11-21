// AP High Court CSIS (https://digi-courts.aphc.ap.gov.in/csis_ap/).
//
// PROVENANCE — read before trusting this file. The protocol and field names below come from the
// portal's own page script (csis_ap/ index inline JS: getCaseDetails.action, base64 JSON, the `v.*`
// fields it renders). They are NOT yet confirmed against a saved real response: no fixture exists
// for this portal. To confirm: run one search with CAPTURE_FIXTURES=1, review
// fixtures/captured/digi-courts.aphc.ap.gov.in/, move it to fixtures/csis-ap/ and add a parser test.
import type { CaseResult, Tier } from "../core/types.js";
import { toIsoDate, normaliseCnr, splitCaseNumber, withContentHash } from "./hcservices-case.js";

// Fields the portal's own JS reads from each record (all strings).
export interface ApCsisRecord {
  cino?: string; maincasenum?: string; srcasenum?: string;
  petitioner?: string; respondent?: string; petitioneradv?: string; respondentadv?: string;
  naturecd?: string; district?: string; filingdate?: string; registrationdate?: string;
  nexthdate?: string; pdrstatus?: string; dispdate?: string; disptype?: string;
  purname?: string; judname?: string; scrutinyofcname?: string; postingstage?: string;
  subject?: string; subject1?: string; subject2?: string; iasrdetails?: string; mpdetails?: string;
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

export function parseApCsisRecord(r: ApCsisRecord, opts: { tier: Tier }): CaseResult {
  const numbering = splitCaseNumber((r.maincasenum ?? "").replace(/\s+/g, " ").replace(/^(\S+)\s+(\d+\/\d{4})$/, "$1 /$2"));
  const disposed = (r.pdrstatus ?? "").trim().toUpperCase() === "DISPOSED";
  const courtData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    purpose: r.purname, scrutinyOfficer: r.scrutinyofcname, postingStage: stripTags(r.postingstage),
    subject: r.subject, subject1: r.subject1, subject2: r.subject2, iaDetails: r.iasrdetails, miscPetitions: r.mpdetails,
  })) { const b = blank(v as string); if (b) courtData[k] = b; }

  const parties = [
    blank(r.petitioner) && { name: blank(r.petitioner)!, role: "petitioner", advocate: blank(r.petitioneradv) },
    blank(r.respondent) && { name: blank(r.respondent)!, role: "respondent", advocate: blank(r.respondentadv) },
  ].filter(Boolean) as CaseResult["parties"];

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
    ].filter(Boolean) as CaseResult["advocates"],
    hearings: [], documents: [],
    courtData: Object.keys(courtData).length ? courtData : undefined,
    warnings: ["AP CSIS mapping is built from the portal's page script; no real response has been saved yet — capture one (CAPTURE_FIXTURES=1) to confirm"],
    fetchedAt: new Date().toISOString(),
    dataSource: "digi-courts.aphc.ap.gov.in/csis_ap",
    tier: opts.tier,
  });
}
