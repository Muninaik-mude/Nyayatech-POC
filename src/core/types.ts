export type CourtLevel = "district" | "high_court";
export type SearchBy = "cnr" | "case" | "filing";
export type Tier = "http" | "lightpanda" | "chromium";
export type CaptchaProvider = "claude" | "gemini";

export interface SearchInput {
  court: CourtLevel;
  bench?: string;
  searchBy: SearchBy;
  cnr?: string;
  caseType?: string;
  caseNumber?: string;
  year?: string;
  filingNumber?: string;
  state?: string;
  district?: string;
  complex?: string;
  quickRunId?: string;
}

export interface Party {
  name: string;
  role: "petitioner" | "respondent" | "advocate" | string;
  advocate?: string;
}

export interface Hearing {
  date: string;
  purpose?: string;
  nextDate?: string;
  judge?: string;
  order?: string;
}

export interface Document {
  id?: string;
  date?: string;
  type: string;
  url?: string;
  localPath?: string;
}

export interface CaseResult {
  caseType?: string;
  caseNumber?: string;
  year?: string;
  cnr?: string;
  filingNumber?: string;
  filingDate?: string;
  status?: string;
  court?: string;
  judge?: string;
  parties: Party[];
  advocates: Party[];
  acts?: string[];
  fir?: string;
  hearings: Hearing[];
  documents: Document[];
  nextDate?: string;
  dataSource: string;
  tier: Tier;
}

export interface RunMetrics {
  runId: string;
  timestamp: string;
  portal: string;
  tier: Tier;
  tierEscalations: { from: Tier; to: Tier; reason: string }[];
  durationMs: number;
  responseBytes: number;
  peakMemoryMb: number;
  captchaAttempts: number;
  captchaSolves: number;
  captchaProvider: CaptchaProvider;
  steps: StepMetric[];
  ok: boolean;
  error?: string;
}

export interface StepMetric {
  name: string;
  tier: Tier;
  durationMs: number;
  ok: boolean;
  captchaAttempts?: number;
}

export interface ApiResponse {
  runId: string;
  ok: boolean;
  tier: Tier;
  case?: CaseResult;
  hearings?: Hearing[];
  documents?: Document[];
  fieldsOnlyInDeep?: string[];
  metrics: RunMetrics;
  error?: string;
}

export interface TierResult {
  html: string;
  tier: Tier;
  durationMs: number;
  bytes: number;
}
