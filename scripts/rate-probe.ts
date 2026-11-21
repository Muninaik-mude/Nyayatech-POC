// npm run rate-probe — how many requests per minute does a portal tolerate from THIS IP before it blocks?
// Uses a captcha-free page (the AP cause-list dates endpoint) so it costs no LLM calls and no case lookups.
// Ramps up requests per minute and stops at the first sign of blocking (HTTP 403/429/5xx or an HTML challenge).
// Be considerate: it stops early, caps at MAX_RPM, and waits between steps. Run it from the IP you will deploy on.
import { fetch } from "undici";

const URL_ = process.env.PROBE_URL ?? "https://aphc.gov.in/Hcdbs/getdates.jsp?listtype=D";
const MAX_RPM = parseInt(process.env.MAX_RPM ?? "60", 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let sent = 0;
  for (let rpm = 6; rpm <= MAX_RPM; rpm *= 2) {
    console.log(`\n== ${rpm} requests/min for 30 s ==`);
    for (let i = 0; i < Math.max(1, rpm / 2); i++) {
      const res = await fetch(URL_, { headers: { "User-Agent": "Mozilla/5.0 (compatible; courts-poc rate-probe)" } });
      const body = await res.text();
      sent++;
      const blocked = res.status === 403 || res.status === 429 || res.status >= 500 || !/\d{2}-\d{2}-\d{4}/.test(body);
      if (blocked) { console.log(`BLOCKED after ${sent} requests at ~${rpm}/min: HTTP ${res.status}, body ${body.length}B`); process.exit(0); }
      await sleep(30_000 / Math.max(1, rpm / 2));
    }
    console.log(`ok — no blocking at ${rpm}/min (${sent} total)`);
    await sleep(10_000);
  }
  console.log(`\nNo blocking up to ${MAX_RPM}/min (${sent} requests).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
