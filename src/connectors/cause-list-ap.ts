import { fetchWithTier } from "../core/tiers.js";
import { parseApCauseList, parseListDates, decodeCourtList, type CauseList } from "../parsers/cause-list-ap.js";

// AP High Court cause list. Public pages, no captcha — plain HTTP with a session cookie.
const BASE = "https://aphc.gov.in/Hcdbs";
export const AP_LIST_TYPES = { D: "Daily", A: "Advance", W: "Weekly", S: "Supplementary", P: "Provisional", F: "Fresh" } as const;
export type ApListType = keyof typeof AP_LIST_TYPES;

async function session(): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  await fetchWithTier({ url: `${BASE}/search.jsp`, method: "GET", cookieJar: jar }, (h) => h.length > 500, "http");
  return jar;
}
const get = async (path: string, jar: Map<string, string>, ok: (b: string) => boolean = () => true) =>
  (await fetchWithTier({ url: `${BASE}/${path}`, method: "GET", cookieJar: jar, headers: { Referer: `${BASE}/search.jsp` } }, ok, "http")).html;

export async function apCauseListDates(type: ApListType): Promise<string[]> {
  const jar = await session();
  return parseListDates(await get(`getdates.jsp?listtype=${type}`, jar));
}

export async function apCauseListCourts(type: ApListType, dateDdMmYyyy: string) {
  const jar = await session();
  const q = new URLSearchParams({ listtype1: type, listdate1: dateDdMmYyyy });
  return decodeCourtList(await get(`courtlist.jsp?${q}`, jar));
}

export async function apCauseList(type: ApListType, dateDdMmYyyy: string, court: string): Promise<CauseList> {
  const jar = await session();
  const res = await fetchWithTier(
    { url: `${BASE}/searchtype.action`, method: "POST", cookieJar: jar, headers: { Referer: `${BASE}/searchtypeinput.action` },
      body: { court, caset: "courtsearch", listdate: dateDdMmYyyy, causelisttype: type } },
    (h) => h.includes("clisttable"), "http");
  const list = parseApCauseList(res.html);
  if (!list) throw new Error("cause list page had no table (no list published for that court/date?)");
  return list;
}
