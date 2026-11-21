import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { decodeApResponse, parseApCsisRecord } from "../src/parsers/csis-ap.ts";

// REAL response, captured live from digi-courts.aphc.ap.gov.in/csis_ap on 2026-11-21 (AS 682/2026).
const decoded = decodeApResponse(fixture("csis-ap/AS-682-2026.b64"));
assert.ok(decoded.ok);
const c = parseApCsisRecord(decoded.records[0], { tier: "http" });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

describe("decodeApResponse", () => {
  test("decodes the real response", () => { assert.equal(decoded.ok && decoded.records.length, 1); });
  test("'[]' means no details (or a rejected captcha) — never a success", () => {
    const d = decodeApResponse(b64([]));
    assert.deepEqual([d.ok, !d.ok && /no details/.test(d.reason)], [false, true]);
  });
  test("a record with an error is rejected and the message is surfaced", () => {
    assert.deepEqual(decodeApResponse(b64([{ error: "Invalid Captcha" }])), { ok: false, reason: "portal error: Invalid Captcha" });
  });
  test("garbage, empty and non-array responses are rejected", () => {
    for (const body of ["", "   ", "<html>Session expired</html>", b64({ a: 1 }), "!!!notbase64!!!"]) assert.equal(decodeApResponse(body).ok, false, JSON.stringify(body));
  });
});

describe("real AP record AS 682/2026", () => {
  test("identity", () => {
    assert.equal(c.cnr, "APHC010596512026");
    assert.deepEqual([c.caseType, c.caseNumber, c.year], ["AS", "682", "2026"]);
    assert.equal(c.registrationNumber, "AS 682/2026");
    assert.equal(c.filingNumber, "ASSR 47370/2026");
    assert.equal(c.registrationDate, "2026-11-11");
    assert.deepEqual([c.benchCode, c.district], ["APHC", "PRAKASAM"]);
  });
  test("status, next date, no fake decision", () => {
    assert.equal(c.status, "PENDING");
    assert.equal(c.nextHearingDate, "2026-12-15");
    assert.equal(c.decisionDate, undefined);
    assert.equal(c.natureOfDisposal, undefined);
    assert.deepEqual(c.category, { name: "NPD" });
  });
  test("both judges kept", () => assert.match(c.judge!, /D RAMESH,.*HARI HARANADHA SARMA/));
  test("numbered parties with their advocate", () => {
    assert.deepEqual(c.parties.map((p) => [p.partyNo, p.name, p.role, p.advocate]), [
      [1, "Raavi Ramesh", "petitioner", "NIMMAGADDA REVATHI"], [1, "Bellamkonda Ravi Kumar", "respondent", undefined],
    ]);
  });
  test("IA / MP applications (2 misc petitions + 2 IASR)", () => {
    assert.equal(c.iaApplications!.length, 4);
    assert.deepEqual(c.iaApplications![0], { number: "IA 2/2026", classification: "Injunction Petition", party: "NIMMAGADDA REVATHI", filingDate: "2026-11-11", status: "Pending" });
    assert.ok(c.iaApplications!.some((a) => a.number === "IASR 96592/2026" && a.status === "PENDING FOR SCRUTINY" && a.filingDate === "2026-11-06"));
  });
  test("lower court", () => {
    assert.deepEqual(c.lowerCourts, [{ courtName: "II ADDL.DISTRICT COURT(FTC) PRAKASAM AT ONGOLE", caseNumber: "OS 77/2021", decisionDate: "2026-05-08", district: "PRAKASAM" }]);
  });
  test("prayer, addresses (PII) and unmodelled lists go to courtData", () => {
    assert.match(String(c.courtData?.prayer), /^Being aggrieved by the Judgment and Decree/);
    assert.equal((c.courtData?.partyAddresses as unknown[]).length, 2);
    assert.equal((c.courtData?.usrdetails as unknown[]).length, 3);
    assert.equal(c.courtData?.orderdetails, undefined);
  });
  test("verified: no 'unverified' warning any more", () => assert.equal(c.warnings, undefined));
  test("non-string values never crash the parser (numbers, null, objects)", () => {
    assert.doesNotThrow(() => parseApCsisRecord({ ...decoded.ok && decoded.records[0], nexthdate: 5 as any, judname: null as any, naturecd: { a: 1 } as any }, { tier: "http" }));
  });
  test("disposed and sentinel dates", () => {
    const base = decoded.ok ? decoded.records[0] : ({} as any);
    const d = parseApCsisRecord({ ...base, pdrstatus: "DISPOSED", dispdate: "20/12/2026", disptype: "ALLOWED" }, { tier: "http" });
    assert.deepEqual([d.decisionDate, d.natureOfDisposal], ["2026-12-20", "ALLOWED"]);
    assert.equal(parseApCsisRecord({ ...base, nexthdate: "01/01/5000" }, { tier: "http" }).nextHearingDate, undefined);
  });
});

// More REAL responses, captured live 2026-11-21.
const real = (f: string) => { const d = decodeApResponse(fixture(`csis-ap/${f}`)); assert.ok(d.ok); return parseApCsisRecord(d.records[0], { tier: "http" }); };

describe("real AP records: disposed cases and orders", () => {
  test("WP 1/2020: disposed, with its final order and the e-signed copy", () => {
    const w = real("WP-1-2020-disposed.b64");
    assert.deepEqual([w.status, w.decisionDate, w.natureOfDisposal], ["DISPOSED", "2020-01-07", "DISPOSED OF NO COSTS"]);
    assert.equal(w.orders!.length, 2);
    assert.deepEqual(w.orders![0], { number: "206300000012020_1", title: "Final Order", orderOn: "WP 1/2020", judge: "The Honourable Sri Justice M.SATYANARAYANA MURTHY", date: "2020-01-07", type: "judgment",
      fileRequest: { url: "https://digi-courts.aphc.ap.gov.in/csis_ap/sdcorderpdf.action", form: { year: "2019", fname: "206300000012020_1", otype: "68" } } });
    assert.deepEqual(w.orders![1], { number: "07_01_2020_DFO", title: "Digi Final Order", orderOn: "WP 1/2020", date: "2020-01-07", type: "judgment",
      fileRequest: { url: "https://digi-courts.aphc.ap.gov.in/csis_ap/sdceorderpdf.action", form: { cino: "APHC010446932019", fname: "07_01_2020_DFO", otype: "Digi Final Order" } } });
    assert.equal(w.courtData?.digiorders, undefined, "digital orders are modelled now");
  });
  test("AS 1/2019: pending with 5 orders, oldest-first order of the portal preserved", () => {
    const a = real("AS-1-2019-orders.b64");
    assert.equal(a.status, "PENDING");
    assert.equal(a.orders!.length, 5);
    assert.equal(a.orders![0].title, "Spl Cell Orders");
    assert.equal(a.orders![0].type, "order");
    assert.ok(a.orders!.every((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date!)));
  });
  test("vakalath advocates are mapped by (R)/(P)", () => {
    const w = real("WP-1-2020-disposed.b64");
    assert.ok(w.advocates.some((x) => x.name === "GP FOR HOME" && x.role === "respondent_advocate"));
  });
  test("CRLP 1/2020: disposed, no orders listed", () => {
    const c = real("CRLP-1-2020-disposed.b64");
    assert.deepEqual([c.status, c.decisionDate, c.natureOfDisposal, c.orders], ["DISPOSED", "2020-01-27", "ALLOWED NO COSTS", []]);
  });
});
