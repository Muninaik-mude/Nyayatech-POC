import { test } from "node:test";
import assert from "node:assert/strict";
import { toIsoDate, splitCaseNumber, normaliseCnr } from "../src/parsers/hcservices-case.ts";

test("toIsoDate handles every format the portals use", () => {
  assert.equal(toIsoDate("27-12-2017"), "2017-12-27");
  assert.equal(toIsoDate(" 27-12-2017 "), "2017-12-27");
  assert.equal(toIsoDate("27/12/2017"), "2017-12-27");
  assert.equal(toIsoDate("28th March 2024"), "2024-03-28");
  assert.equal(toIsoDate("1st January 2026"), "2026-01-01");
  assert.equal(toIsoDate("2024-03-28"), "2024-03-28");
});

test("toIsoDate returns undefined for blanks, placeholders and impossible dates", () => {
  for (const v of ["", "  ", "--", "-", " ", undefined, null, "31-02-2024", "13-13-2024", "soon", "00-00-0000"]) {
    assert.equal(toIsoDate(v as string), undefined, `input ${JSON.stringify(v)}`);
  }
});

test("splitCaseNumber copes with parentheses and dots in case types", () => {
  assert.deepEqual(splitCaseNumber("AS /45/2018"), { type: "AS", number: "45", year: "2018" });
  assert.deepEqual(splitCaseNumber("WP(C) /31129/2026"), { type: "WP(C)", number: "31129", year: "2026" });
  assert.deepEqual(splitCaseNumber("CRL.M.C. /73/2026"), { type: "CRL.M.C.", number: "73", year: "2026" });
  assert.deepEqual(splitCaseNumber("garbage"), {});
});

test("normaliseCnr strips dashes and upper-cases", () => {
  assert.equal(normaliseCnr("hbhc01-103220-2017"), "HBHC011032202017");
  assert.equal(normaliseCnr(" KAHC010112112026 "), "KAHC010112112026");
});
