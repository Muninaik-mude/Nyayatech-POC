// npm run build-hierarchy — builds data/court-hierarchy.json (state → district [→ court complex])
// from the public eCourts services portal, driven through a real Chrome (the portal's lookup calls
// need a live browser session; plain HTTP gets "Invalid Request").
//
//   npm run build-hierarchy                  states + districts (~36 lookups, ~1 minute)
//   LEVEL=complexes npm run build-hierarchy  also court complexes (~800 lookups, ~15 minutes — run it rarely, monthly at most)
//
// Sequential with a pause between lookups, to stay polite to the portal.
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

type Option = { code: string; name: string };
const PAUSE_MS = parseInt(process.env.PAUSE_MS ?? "400", 10);
const WITH_COMPLEXES = process.env.LEVEL === "complexes";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const resp = await page.goto("https://services.ecourts.gov.in/ecourtindia_v6/?p=casestatus/index", { waitUntil: "networkidle", timeout: 60_000 });
  if (!resp || resp.status() !== 200) {
    // e.g. HTTP 405 when the portal is refusing this IP/session. Do not retry in a loop or work around it.
    throw new Error(`portal answered HTTP ${resp?.status()} for the case-status page — it is refusing this connection right now. Wait and try again later; nothing was written.`);
  }

  const options = (sel: string): Promise<Option[]> =>
    page.$$eval(`${sel} option`, (os) => os.map((o) => ({ code: (o as HTMLOptionElement).value, name: (o.textContent ?? "").trim() }))
      .filter((o) => o.code && o.code !== "0" && !/^select/i.test(o.name)));

  const states = await options("#sess_state_code");
  if (!states.length) throw new Error("no states found on the page (layout changed or blocked) — nothing was written");
  const out: any[] = [];
  for (const [i, s] of states.entries()) {
    let districts: Option[] = [];
    for (let attempt = 1; attempt <= 3 && !districts.length; attempt++) { // the portal sometimes answers a lookup empty; retry, never record a silent 0
      if (attempt > 1) await sleep(1500 * attempt);
      // Empty the list first: otherwise the wait below is satisfied by the PREVIOUS state's districts
      // (a real bug in an earlier version — every state got its neighbour's list).
      await page.evaluate(() => { document.querySelector("#sess_dist_code")!.innerHTML = '<option value="">Select district</option>'; });
      await page.selectOption("#sess_state_code", s.code);
      await page.waitForFunction(() => document.querySelectorAll("#sess_dist_code option").length > 1, null, { timeout: 12_000 }).catch(() => {});
      districts = await options("#sess_dist_code");
    }
    const prevNames = out.length ? out[out.length - 1].districts.map((d: Option) => d.name).join("|") : "";
    if (districts.length && districts.map((d) => d.name).join("|") === prevNames) {
      throw new Error(`${s.name} returned exactly the previous state's districts — stale read, refusing to write bad data`);
    }
    if (!districts.length) console.warn(`  WARNING: no districts returned for ${s.name} after 3 tries`);
    const row: any = { code: s.code, name: s.name, districts: districts.map((d) => ({ ...d })) };
    console.log(`[${i + 1}/${states.length}] ${s.name}: ${districts.length} districts`);
    if (WITH_COMPLEXES) {
      for (const d of row.districts) {
        await page.evaluate(() => { document.querySelector("#court_complex_code")!.innerHTML = '<option value="">Select court complex</option>'; });
        await page.selectOption("#sess_dist_code", d.code);
        await page.waitForFunction(() => document.querySelectorAll("#court_complex_code option").length > 1, null, { timeout: 15_000 }).catch(() => {});
        // option value is "<complex code>@<establishment codes>"; keep both
        d.complexes = (await options("#court_complex_code")).map((c) => ({ code: c.code.split("@")[0], establishments: c.code.split("@")[1], name: c.name }));
        await sleep(PAUSE_MS);
      }
    }
    out.push(row);
    await sleep(PAUSE_MS);
  }
  await browser.close();

  const file = path.resolve("data/court-hierarchy.json");
  fs.writeFileSync(file, JSON.stringify({ source: "services.ecourts.gov.in/ecourtindia_v6 (case status page)", fetchedAt: new Date().toISOString(), level: WITH_COMPLEXES ? "complexes" : "districts", states: out }, null, 2) + "\n");
  console.log(`wrote ${file}: ${out.length} states, ${out.reduce((n, s) => n + s.districts.length, 0)} districts`);
}
main().catch((e) => { console.error(e); process.exit(1); });
