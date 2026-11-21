import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeApResponse, parseApCsisRecord, type ApCsisRecord } from "../src/parsers/csis-ap.ts";

// SYNTHETIC. Built from the field names the portal's own page script reads (v.maincasenum, v.cino, …),
// NOT captured from a real response. It tests our decoding and mapping logic only; the real format of
// each value is unconfirmed until a fixture is captured (see src/parsers/csis-ap.ts).
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const record: ApCsisRecord = {
  error: "-", cino: "APHC010596512026", maincasenum: "AS 682/2026", srcasenum: "AS 59651/2026",
  petitioner: "Raavi Ramesh", respondent: "Bellamkonda Ravi Kumar", petitioneradv: "NIMMAGADDA REVATHI", respondentadv: "-",
  naturecd: "SPECIFIC PERFORMANCE", district: "KRISHNA", filingdate: "04/11/2026", registrationdate: "11/11/2026",
  nexthdate: "17/11/2026", pdrstatus: "PENDING", dispdate: "01/01/1900", disptype: "-", purname: "FOR ADMISSION",
  judname: "JUSTICE X", scrutinyofcname: "OFFICER Y", postingstage: "<td>Posted</td>", subject: "", iasrdetails: "-", mpdetails: "-",
};

describe("decodeApResponse", () => {
  test("decodes base64 JSON records", () => {
    const d = decodeApResponse(b64([record]) + "\n");
    assert.ok(d.ok);
    assert.equal(d.ok && d.records[0].cino, "APHC010596512026");
  });
  test("'[]' means no details (or a rejected captcha) — never a success", () => {
    const d = decodeApResponse(b64([]));
    assert.deepEqual([d.ok, !d.ok && /no details/.test(d.reason)], [false, true]);
  });
  test("a record with an error is rejected and the message is surfaced", () => {
    const d = decodeApResponse(b64([{ error: "Invalid Captcha" }]));
    assert.deepEqual(d, { ok: false, reason: "portal error: Invalid Captcha" });
  });
  test("garbage, empty and non-array responses are rejected", () => {
    for (const body of ["", "   ", "<html>Session expired</html>", b64({ a: 1 }), "!!!notbase64!!!"]) {
      assert.equal(decodeApResponse(body).ok, false, JSON.stringify(body));
    }
  });
});

describe("parseApCsisRecord", () => {
  const c = parseApCsisRecord(record, { tier: "http" });
  test("identity", () => {
    assert.equal(c.cnr, "APHC010596512026");
    assert.deepEqual([c.caseType, c.caseNumber, c.year], ["AS", "682", "2026"]);
    assert.equal(c.registrationNumber, "AS 682/2026");
    assert.equal(c.filingNumber, "AS 59651/2026");
    assert.equal(c.registrationDate, "2026-11-11");
    assert.equal(c.benchCode, "APHC");
  });
  test("status and next date", () => {
    assert.equal(c.status, "PENDING");
    assert.equal(c.nextHearingDate, "2026-11-17");
    assert.equal(c.decisionDate, undefined, "the 01/01/1900 sentinel is not a date");
    assert.equal(c.natureOfDisposal, undefined);
  });
  test("'-' placeholders become undefined; parties and advocates are linked", () => {
    assert.deepEqual(c.parties.map((p) => [p.name, p.role, p.advocate]), [
      ["Raavi Ramesh", "petitioner", "NIMMAGADDA REVATHI"], ["Bellamkonda Ravi Kumar", "respondent", undefined],
    ]);
    assert.deepEqual(c.advocates, [{ name: "NIMMAGADDA REVATHI", role: "petitioner_advocate", forParties: ["Raavi Ramesh"] }]);
    assert.equal(c.courtData?.iaDetails, undefined);
  });
  test("unmapped fields land in courtData, HTML stripped", () => {
    assert.equal(c.courtData?.purpose, "FOR ADMISSION");
    assert.equal(c.courtData?.postingStage, "Posted");
  });
  test("disposed cases carry decision date and disposal type", () => {
    const d = parseApCsisRecord({ ...record, pdrstatus: "DISPOSED", dispdate: "20/12/2026", disptype: "ALLOWED" }, { tier: "http" });
    assert.deepEqual([d.status, d.decisionDate, d.natureOfDisposal], ["DISPOSED", "2026-12-20", "ALLOWED"]);
  });
  test("the 01/01/5000 'no next date' sentinel is dropped", () => {
    assert.equal(parseApCsisRecord({ ...record, nexthdate: "01/01/5000" }, { tier: "http" }).nextHearingDate, undefined);
  });
  test("always carries the unverified warning until a real fixture exists", () => {
    assert.match(c.warnings![0], /no real response has been saved/);
  });
});
