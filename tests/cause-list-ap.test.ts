import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parseApCauseList, parseListDates, decodeCourtList, ddmmyyyyToIso } from "../src/parsers/cause-list-ap.ts";

// Real pages from aphc.gov.in/Hcdbs, saved 2026-11-21 (fixtures/cause-list-ap/).
const dir = path.resolve("fixtures/cause-list-ap");
const html = fs.readFileSync(path.join(dir, "court2-2026-11-21.html"), "latin1");
const list = parseApCauseList(html)!;

describe("AP cause list (real page, court 2)", () => {
  test("header", () => {
    assert.equal(list.listDate, "2026-11-21");
    assert.equal(list.listType, "D");
    assert.equal(list.courtNo, "COURT NO. 2");
    assert.deepEqual(list.judges, ["THE HONOURABLE SRI JUSTICE B KRISHNA MOHAN", "THE HONOURABLE SRI JUSTICE SUBHENDU SAMANTA"]);
    assert.match(list.hearingNote!, /^To be Heard on Saturday/);
    assert.equal(list.title, "(CAUSE LIST MOTION HEARING)");
  });
  test("every numbered row is parsed (78 case links on the page)", () => {
    assert.equal(list.entries.length, 78);
    assert.deepEqual(list.entries.slice(0, 3).map((e) => e.serial), [1, 2, 3]);
  });
  test("first entry in full", () => {
    assert.deepEqual(list.entries[0], {
      serial: 1, section: "FOR ADMISSION", caseNumber: "MACMA/873/2026", arisingFrom: "MVOP/204/2023",
      applications: ["IA 1/2026", "Stay Petition"],
      petitioner: "SHRIRAM GENERAL INSURANCE COMPANY LIMITED", respondent: "PALUGULLA VENKATA RAMANAMMA",
      petitionerAdvocate: "KORAGANTI SREENIVASARAO", respondentAdvocate: undefined, district: "YSR KADAPA",
    });
  });
  test("entries carry the section heading they sit under; sections change", () => {
    const sections = new Set(list.entries.map((e) => e.section));
    assert.ok(sections.has("FOR ADMISSION") && sections.has("FOR ORDERS OF COURT") && sections.has("INTERLOCUTORY"), [...sections].join("|"));
    assert.ok(list.entries.every((e) => e.section));
  });
  test("invariants: case numbers look like TYPE/NO/YEAR; parties present", () => {
    for (const e of list.entries) {
      assert.match(e.caseNumber, /^[A-Za-z()-]{1,20}\/\d{1,8}\/\d{4}$/, `row ${e.serial}`);
      assert.ok(e.petitioner, `row ${e.serial} petitioner`);
    }
  });
  test("unregistered cases are flagged and their number is cleaned", () => {
    const f = list.entries.filter((e) => e.filingNumberOnly);
    assert.deepEqual(f.map((e) => e.caseNumber), ["CRP/17219/2026", "SA/23534/2026", "SA/41379/2026", "CC/17212/2026", "CC/39121/2026"]);
    assert.ok(list.entries.filter((e) => !e.filingNumberOnly).every((e) => !e.caseNumber.includes("Filing")));
  });
  test("not a cause list → undefined", () => {
    assert.equal(parseApCauseList("<html><body>Error</body></html>"), undefined);
  });
});

test("dates list", () => {
  const raw = fs.readFileSync(path.join(dir, "dates-D.txt"), "utf8");
  assert.deepEqual(parseListDates(raw), ["2026-11-21", "2026-11-20", "2026-11-19", "2026-11-18", "2026-11-17", "2026-11-16"]);
  for (const code of ["0", "1", "2", "", "  "]) assert.deepEqual(parseListDates(code), []);
  assert.equal(ddmmyyyyToIso("5-1-2026"), "2026-01-05");
});

test("court list (base64 JSON)", () => {
  const courts = decodeCourtList(fs.readFileSync(path.join(dir, "courtlist-D.b64"), "utf8"));
  assert.ok(courts.length > 5);
  assert.deepEqual(courts[0], { code: "2", name: "COURT NO. 2" });
  for (const code of ["0", "4", "", "!!notbase64!!"]) assert.deepEqual(decodeCourtList(code), []);
});
