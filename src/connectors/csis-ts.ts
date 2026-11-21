import { SearchInput, CaseResult, Tier } from "../core/types.js";
import { FetchWithTierResult } from "../core/tiers.js";
import { SearchError } from "../core/captcha.js";

export interface CsisTsConnectorResult {
  caseResult: CaseResult;
  rawHtml: string;
  escalations: FetchWithTierResult["escalations"];
  tier: Tier;
  durationMs: number;
  bytes: number;
  captchaAttempts: number;
  captchaSolves: number;
  fieldsOnlyInDeep: string[];
}

// NOT IMPLEMENTED — on purpose. The previous version posted to invented URLs and could never work.
// What is known (checked 2026-11-21):
//  * https://csis.tshc.gov.in/ is a JavaScript app (assets/js/index.js, fetch.js) with forms for
//    registration no (#rType #rNumber #rYear #rCaptcha), filing no, advocate, party, trial court, FIR.
//  * Plain HTTP only receives a bot-fingerprint challenge page; the real page needs a real browser session.
//  * The search endpoints are in assets/js/fetch.js and have not been mapped.
// Telangana cases are still searchable by CNR through hcservices (prefix HBHC → TSHC).
export async function csisTsSearch(
  _input: SearchInput,
  _quickResult?: CaseResult,
  _runId?: string,
  _runsDir?: string,
  _forceTier?: Tier
): Promise<CsisTsConnectorResult> {
  throw new SearchError(
    "TS HC deep search is not available: csis.tshc.gov.in sits behind a JavaScript bot challenge and its search endpoints are not mapped. " +
    "Use the normal search (hcservices, CNR prefix HBHC) for Telangana cases."
  );
}
