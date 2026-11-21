import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { FIXTURES, fixture } from "./helpers.ts";
import {
  parseHcCaseHtml, parseFilingList, isCaseDetailPage, isFilingListResponse,
} from "../src/parsers/hcservices-case.ts";

const parse = (file: string, bench = "XX") => parseHcCaseHtml(fixture(`hcservices/${file}`), { tier: "http", bench });
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const CASE_FIXTURES = fs.readdirSync(path.join(FIXTURES, "hcservices")).filter((f) => /^[A-Z]{4}\d+\.html$/.test(f));

describe("invariants over every saved real case page", () => {
  test("fixtures exist", () => assert.ok(CASE_FIXTURES.length >= 10, `only ${CASE_FIXTURES.length} fixtures`));

  for (const file of CASE_FIXTURES) {
    test(file, () => {
      const html = fixture(`hcservices/${file}`);
      assert.ok(isCaseDetailPage(html));
      const c = parse(file);

      // identity
      assert.match(c.cnr ?? "", /^[A-Z]{4}\d{12}$/, "CNR normalised: 4 letters + 12 digits, no dashes");
      assert.equal(c.cnr, file.replace(".html", ""));
      assert.equal(c.courtCode, c.cnr!.slice(4, 6));
      assert.ok(c.caseType && c.caseNumber && c.year, "type/number/year split from the registration number");

      // every structured date is ISO
      const dates = [
        c.registrationDate, c.decisionDate, c.firstHearingDate, c.nextHearingDate,
        ...c.hearings.flatMap((h) => [h.hearingDate, h.businessOnDate]),
        ...(c.orders ?? []).map((o) => o.date),
        ...(c.iaApplications ?? []).flatMap((i) => [i.filingDate, i.nextDate]),
        ...(c.lowerCourts ?? []).map((l) => l.decisionDate),
        ...(c.filings ?? []).map((f) => f.receivedDate),
      ].filter((d) => d !== undefined);
      for (const d of dates) assert.match(d!, ISO);

      // nothing is silently dropped: row counts equal what the raw HTML contains
      assert.equal(c.hearings.length, (html.match(/viewBusiness\(/g) ?? []).length, "hearings");
      assert.equal(c.orders!.length, (html.match(/display_pdf\.php/g) ?? []).length, "orders with a PDF link");
      assert.equal(c.documents.length, c.orders!.length);
      assert.equal(c.iaApplications!.length, (html.match(/Classification :/g) ?? []).length, "IA rows");

      // parties/advocates are linked, and no line was left unparsed
      assert.equal(c.courtData?.unparsedPartyLines, undefined, "unparsed party lines");
      const names = new Set(c.parties.map((p) => p.name));
      for (const a of c.advocates) {
        assert.ok(a.forParties!.length > 0);
        for (const n of a.forParties!) assert.ok(names.has(n), `${a.name} → unknown party ${n}`);
      }
      for (const p of c.parties) assert.ok(p.name.length > 0 && p.partyNo! > 0);

      // status is never invented
      assert.ok(c.status === "Pending" || /dispos/i.test(c.status!), `status ${c.status}`);
      if (c.decisionDate) assert.ok(/dispos/i.test(c.status!));

      // change detection: same input → same hash; fetchedAt/tier do not affect it
      const again = parseHcCaseHtml(html, { tier: "chromium", bench: "XX" });
      assert.equal(again.contentHash, c.contentHash);
      assert.match(c.contentHash!, /^[0-9a-f]{64}$/);
    });
  }

  test("different cases hash differently", () => {
    const hashes = new Set(CASE_FIXTURES.map((f) => parse(f).contentHash));
    assert.equal(hashes.size, CASE_FIXTURES.length);
  });

  test("a changed page changes the hash", () => {
    const html = fixture("hcservices/HBHC011032202017.html");
    const a = parseHcCaseHtml(html, { tier: "http", bench: "TSHC" });
    const b = parseHcCaseHtml(html.replace("28th March 2024", "4th April 2024"), { tier: "http", bench: "TSHC" });
    assert.notEqual(a.contentHash, b.contentHash);
    assert.equal(b.nextHearingDate, "2024-04-04");
  });
});

describe("HBHC011032202017 — Telangana, pending, dashed CNR, many parties", () => {
  const c = parse("HBHC011032202017.html", "TSHC");

  test("identity", () => {
    assert.equal(c.cnr, "HBHC011032202017");
    assert.equal(c.filingNumber, "AS /248953/2017");
    assert.equal(c.filingDate, "27-12-2017");
    assert.equal(c.registrationNumber, "AS /45/2018");
    assert.equal(c.registrationDate, "2018-01-10");
    assert.deepEqual([c.caseType, c.caseNumber, c.year], ["AS", "45", "2018"]);
    assert.equal(c.benchCode, "TSHC");
    assert.equal(c.courtCode, "01");
    assert.equal(c.state, "TELANGANA");
    assert.equal(c.district, "HYDERABAD");
    assert.equal(c.sourceCaseId, undefined, "has a CNR, so no fallback id");
  });

  test("status", () => {
    assert.equal(c.status, "Pending");
    assert.equal(c.stage, "FINAL HEARING");
    assert.equal(c.nextHearingDate, "2024-03-28");
    assert.equal(c.nextDate, "28th March 2024");
    assert.equal(c.firstHearingDate, undefined);
    assert.equal(c.decisionDate, undefined);
    assert.equal(c.judge, "P.SREE SUDHA");
    assert.equal(c.benchType, "Single Bench");
    assert.equal(c.judicialBranch, "CIVIL Section");
  });

  test("parties are linked to their advocates", () => {
    assert.equal(c.parties.filter((p) => p.role === "petitioner").length, 4);
    assert.equal(c.parties.filter((p) => p.role === "respondent").length, 15);
    assert.deepEqual(c.parties[0], { name: "Kista Reddy", role: "petitioner", partyNo: 1, advocate: "Y RAMA RAO", advocates: ["Y RAMA RAO"] });
    assert.equal(c.parties[2].name, "Atloori Laxman Rao", "trailing comma stripped");
    assert.equal(c.parties[2].advocates, undefined);
    assert.deepEqual(c.advocates.map((a) => [a.name, a.role, a.forParties!.length]), [
      ["Y RAMA RAO", "petitioner_advocate", 1],
      ["MANDA ADAM", "respondent_advocate", 7],
    ]);
  });

  test("acts, lower court, IA", () => {
    assert.deepEqual(c.actsStructured, [{ name: "CODE OF CIVIL PROCEDURE", sections: "96" }]);
    assert.deepEqual(c.acts, ["CODE OF CIVIL PROCEDURE s.96"]);
    assert.deepEqual(c.lowerCourts, [{
      courtName: "SENIOR CIVIL JUDGE COURT, SANGAREDDY", caseNumber: "OS - 0000260 - 2008",
      decisionDate: "2017-08-22", state: "TELANGANA", district: "MEDAK",
    }]);
    assert.equal(c.iaApplications!.length, 3);
    assert.deepEqual(c.iaApplications![0], {
      number: "IA/1/2017", classification: "Suspension Petition", party: "Kista Reddy",
      filingDate: "2017-12-27", nextDate: undefined, status: "Pending",
    });
    assert.equal(c.iaApplications![2].nextDate, "2023-12-27");
  });

  test("hearings keep business-on date, hearing date and purpose separate", () => {
    assert.equal(c.hearings.length, 29);
    assert.deepEqual(c.hearings[0], {
      date: "30-01-2018", causeListType: "DAILY LIST", judge: "A.SHANKAR NARAYANA",
      businessOnDate: undefined, hearingDate: "2018-01-30", purpose: "INTERLOCUTORY",
    });
    assert.deepEqual(c.hearings[1], {
      date: "28-03-2024", causeListType: "DAILY LIST", judge: "P.SREE SUDHA",
      businessOnDate: "2024-02-09", hearingDate: "2024-03-28", purpose: "FINAL HEARING",
    });
  });

  test("orders: number, date, judge and an absolute PDF url", () => {
    assert.equal(c.orders!.length, 3);
    const o = c.orders![0];
    assert.deepEqual([o.number, o.orderOn, o.judge, o.date, o.type], ["1", "IA/1/2017", "A.SHANKAR NARAYANA", "2018-02-15", "order"]);
    assert.match(o.fileUrl!, /^https:\/\/hcservices\.ecourts\.gov\.in\/hcservices\/cases\/display_pdf\.php\?filename=/);
    assert.deepEqual(c.documents[0], { id: "1", date: "15-02-2018", type: "order", url: o.fileUrl });
  });

  test("objections", () => {
    assert.equal(c.objections!.length, 2);
    assert.equal(c.objections![0].objection, "All Objections are Complied");
    assert.equal(c.objections![0].complianceDate, "29-12-2017");
    assert.equal(c.objections![0].receiptDate, undefined, "blank column stays undefined");
  });
});

describe("Delhi DLHC011079002025 — orders with PDFs, case type with dots", () => {
  const c = parse("DLHC011079002025.html", "DLHC");
  test("case numbering", () => assert.deepEqual([c.caseType, c.caseNumber, c.year], ["CRL.M.C.", "73", "2026"]));
  test("six orders with PDF links", () => {
    assert.equal(c.orders!.length, 6);
    assert.deepEqual([c.orders![0].number, c.orders![0].orderOn, c.orders![0].judge, c.orders![0].date],
      ["1", "CRL.M.C./73/2026", "HON'BLE MR. JUSTICE MANOJ JAIN", "2026-01-06"]);
    for (const o of c.orders!) assert.match(o.fileUrl!, /display_pdf\.php.*cino=DLHC011079002025/);
  });
  test("court-specific label is kept in courtData, not dropped", () => {
    assert.deepEqual(c.courtData, { unmappedFields: { "not before me": "NO COURT NO COURT AT PRESENT" } });
  });
});

describe("Gujarat GJHC240715442026 — disposed, linked main case, comma-list advocates", () => {
  const c = parse("GJHC240715442026.html", "GUHC");
  test("disposal fields", () => {
    assert.equal(c.status, "Case disposed");
    assert.equal(c.decisionDate, "2026-10-08");
    assert.equal(c.natureOfDisposal, "--33-CA DISPOSED OF");
    assert.equal(c.cnr, "GJHC240715442026");
    assert.equal(c.courtCode, "24");
  });
  test("main-case link (label there is 'Case Number', not 'Filing Number')", () => {
    assert.deepEqual(c.linkedCases, [{ relation: "main", filingNumber: "FA/4522/2026" }]);
  });
  test("advocates split on commas and de-duplicated", () => {
    const names = c.advocates.map((a) => a.name);
    assert.ok(names.includes("MR TEJAS P SATTA(3149)"));
    assert.equal(names.filter((n) => n === "MR KRUSHNAKANT D PATEL(10632)").length, 1);
    assert.ok(names.includes("GOVERNMENT PLEADER(1)"));
    assert.equal(c.advocates.length, 3);
  });
  test("long category names with codes", () => {
    assert.deepEqual(c.category, { name: "515-SJ - CIVIL APPLICATION - LIMITATION ACT, 1963", code: "515" });
    assert.equal(c.subCategory!.code, "1580");
  });
  test("objections keep their text", () => {
    assert.equal(c.objections!.length, 2);
    assert.match(c.objections![0].objection!, /BLANKS IN MEMO/);
  });
});

describe("Madras HCMA010003402026 — disposed, main matter", () => {
  const c = parse("HCMA010003402026.html", "TNHC");
  test("disposal", () => {
    assert.equal(c.status, "Case disposed");
    assert.equal(c.decisionDate, "2026-03-18");
    assert.equal(c.natureOfDisposal, "--DISPOSED OF");
    assert.equal(c.firstHearingDate, undefined);
  });
  test("category and link", () => {
    assert.deepEqual(c.category, { name: "Service", code: "140" });
    assert.deepEqual(c.linkedCases, [{ relation: "main", filingNumber: "WP/165/2026" }]);
  });
});

describe("Madras HCMA010009692026 — sub matter, bare advocate lines, filings", () => {
  const c = parse("HCMA010009692026.html", "TNHC");
  test("sub-matter link", () => assert.deepEqual(c.linkedCases, [{ relation: "sub", filingNumber: "SUB APPL/2104/2026" }]));
  test("advocate with no 'Advocate-' prefix, two names comma-separated", () => {
    assert.equal(c.parties[0].name, "T.N.Santhanakrishnan");
    assert.deepEqual(c.parties[0].advocates, ["M/S.M.V.SESHACHARI", "C.HARINI"]);
  });
  test("filed documents table", () => {
    assert.equal(c.filings!.length, 9);
    assert.ok(c.filings!.every((f) => f.documentNo && f.receivedDate));
  });
  test("two objections, one still open", () => {
    assert.equal(c.objections!.length, 2);
    assert.match(c.objections![0].objection!, /Other Objection/);
    assert.equal(c.objections![1].objection, "All Objections are Complied");
  });
});

describe("Kerala KLHC010686562026 — FIR and two lower courts", () => {
  const c = parse("KLHC010686562026.html", "KLHC");
  test("structured FIR", () => {
    assert.deepEqual(c.firDetails, { state: "Kerala", district: "Wayanad", policeStation: "Vythiri Police Station", firNumber: "87", year: "2019" });
    assert.equal(c.fir, "Vythiri Police Station, FIR 87, 2019");
  });
  test("lower courts (appellate, then trial)", () => {
    assert.equal(c.lowerCourts!.length, 2);
    assert.deepEqual(c.lowerCourts![0], {
      courtName: "ADDITIONAL DISTRICT COURT & SESSIONS COURT - II & RENT CONTROL APPELLATE AUTHORITY, KALPETTA",
      caseNumber: "Crl.A - 0000021 - 2025", decisionDate: "2026-05-30", state: "Kerala", district: "Wayanad",
    });
    assert.equal(c.lowerCourts![1].courtName, "CHIEF JUDICIAL MAGISTRATE, KALPETTA");
    assert.equal(c.lowerCourts![1].caseNumber, "CC - 0000229 - 2019");
  });
  test("e-filing fields land in courtData", () => {
    assert.equal((c.courtData!.unmappedFields as Record<string, string>)["e-filno."], "EF-HCK-2026-074746");
  });
});

describe("Karnataka KAHC010112112026 — trial court with no decision date", () => {
  const c = parse("KAHC010112112026.html", "KRHC");
  test("'--' decision date is undefined, not a string", () => {
    assert.equal(c.lowerCourts!.length, 1);
    assert.equal(c.lowerCourts![0].courtName, "XXII ADDL. CITY CIVIL AND SESSIONS JUDGE, BENGALURU");
    assert.equal(c.lowerCourts![0].decisionDate, undefined);
    assert.equal(c.lowerCourts![0].state, "KARNATAKA");
  });
  test("pending status is derived, stage is separate", () => {
    assert.equal(c.status, "Pending");
    assert.equal(c.stage, "PRELIMINARY HEARING");
  });
  test("party and advocate", () => {
    assert.deepEqual([c.parties[0].name, c.parties[0].advocate], ["SRI MUNIREDDY", "SRINIVASAN T"]);
    assert.equal(c.parties.filter((p) => p.role === "respondent").length, 8);
  });
  test("category / sub category with codes", () => {
    assert.deepEqual(c.category, { name: "WP", code: "144" });
    assert.deepEqual(c.subCategory, { name: "KLR-Land Revenue Act", code: "19" });
  });
});

describe("other courts", () => {
  test("Orissa: FIR + bare advocate line", () => {
    const c = parse("ODHC010822902026.html", "ORHC");
    assert.deepEqual(c.firDetails, { state: "ORISSA", district: "Cuttack", policeStation: "G.R.P.S.", firNumber: "55", year: "2026" });
    assert.deepEqual(c.parties[0].advocates, ["LOKANATH NAIK"]);
    assert.equal(c.parties.find((p) => p.name === "STATE OF ODISHA")?.advocates, undefined);
  });
  test("Tripura: FIR + comma list with an empty element", () => {
    const c = parse("TRHC010020532026.html", "TRHC");
    assert.equal(c.firDetails!.policeStation, "Agartala GRP");
    assert.deepEqual(c.parties[0].advocates, ["Veerendra Mohan", "MR SUBHRADIP SHARMA"]);
  });
  test("Madhya Pradesh: sparse page (no history, no acts) parses to empty lists, not errors", () => {
    const c = parse("MPHC010592572026.html", "MPHC");
    assert.deepEqual([c.hearings.length, c.actsStructured!.length, c.orders!.length], [0, 0, 0]);
    assert.deepEqual(c.parties[0].advocates, ["WARIJA GHILDIYAL[P-1]"]);
    assert.equal(c.nextHearingDate, "2026-08-14");
  });
  test("Andhra: filings and e-filing number", () => {
    const c = parse("APHC010596512026.html", "APHC");
    assert.equal(c.filings!.length, 3);
    assert.equal(c.iaApplications!.length, 2);
    assert.equal((c.courtData!.unmappedFields as Record<string, string>)["e-filno."], "AAP20240000303C202600040");
  });
});

describe("responses that are NOT a case page are rejected", () => {
  const rejected = ["", "null", "Invalid Captcha", "THERE IS AN ERROR", "Error: session expired", "<html><body>Please enter captcha</body></html>"];
  for (const body of rejected) {
    test(JSON.stringify(body.slice(0, 40)), () => {
      assert.equal(isCaseDetailPage(body), false);
      assert.equal(isFilingListResponse(body), false);
    });
  }
  test("the filing list is not mistaken for a case page, and vice versa", () => {
    assert.equal(isCaseDetailPage(fixture("hcservices/filing-search-list.html")), false);
    assert.equal(isFilingListResponse(fixture("hcservices/HBHC011032202017.html")), false);
  });
});

describe("filing-number search list (tilde-delimited, old portal)", () => {
  const html = fixture("hcservices/filing-search-list.html");
  const c = parseFilingList(html, { tier: "http", bench: "KRHC" });
  test("recognised", () => assert.ok(isFilingListResponse(html)));
  test("first match becomes the case, with ITS parties only", () => {
    assert.equal(c.cnr, "KAHC010247872026");
    assert.deepEqual([c.caseType, c.caseNumber, c.year], ["WP", "11211", "2026"]);
    assert.equal(c.status, "Disposed");
    assert.equal(c.court, "Principal Bench at Bengaluru");
    assert.deepEqual(c.parties.map((p) => [p.name, p.role]), [["GEETHA", "petitioner"], ["STATE OF KARNATAKA", "respondent"]]);
  });
  test("other matches are kept, not merged into the first case", () => {
    const others = (c.courtData as { otherMatches: Array<{ caseNumber: string; cnr: string; status: string; parties: string[] }> }).otherMatches;
    assert.equal(others.length, 1);
    assert.deepEqual([others[0].caseNumber, others[0].cnr, others[0].status], ["CRL.P/11211/2026", "KAHC010513082026", "Pending"]);
    assert.deepEqual(others[0].parties, ["SRI. C.H. SANJAY", "STATE OF KARNATAKA"]);
  });
});
