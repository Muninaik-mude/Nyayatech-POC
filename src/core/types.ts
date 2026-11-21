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

// ---------------------------------------------------------------------------
// Common (superset) case schema — see research doc sec 3.
// Conventions:
//  * New date fields are ISO "YYYY-MM-DD" (undefined when blank / "--").
//  * Legacy display fields (filingDate, nextDate, Hearing.date) keep the portal's raw text.
//  * Anything the portal shows that has no home yet goes to `courtData` (jsonb passthrough).
// ---------------------------------------------------------------------------

export interface Party {
  name: string;
  role: "petitioner" | "respondent" | string;
  partyNo?: number;          // order of the party on the portal ("1)", "2)" …)
  advocate?: string;         // legacy: advocates joined with ", "
  advocates?: string[];      // advocates linked to THIS party
}

export interface Advocate {
  name: string;
  role: "petitioner_advocate" | "respondent_advocate" | "advocate" | string;
  forParties?: string[];     // names of the parties this advocate appears for
}

export interface Hearing {
  date: string;              // legacy: hearing date as shown by the portal
  purpose?: string;
  nextDate?: string;
  judge?: string;
  order?: string;
  causeListType?: string;
  businessOnDate?: string;   // ISO — "Business on Date" column
  hearingDate?: string;      // ISO — "Hearing Date" column
}

export interface Document {
  id?: string;
  date?: string;
  type: string;
  url?: string;
  localPath?: string;
}

export interface Act { name: string; sections?: string }

export interface Fir {
  state?: string;
  district?: string;
  policeStation?: string;
  firNumber?: string;
  year?: string;
}

// "order" = HC orders table. "interim_order" / "judgment" are reserved: no portal fixture
// has been captured for them yet, so no parser sets them.
export interface Order {
  number: string;
  orderOn?: string;          // case number the order was passed on
  judge?: string;
  date?: string;             // ISO
  type: "order" | "interim_order" | "judgment";
  fileUrl?: string;          // absolute portal URL of the PDF
  localPath?: string;        // set once the PDF has been downloaded
}

export interface IaApplication {
  number: string;
  classification?: string;
  party?: string;
  filingDate?: string;       // ISO
  nextDate?: string;         // ISO
  status?: string;
}

export interface Objection {
  srNo?: string;
  subCategory?: string;      // NB: portal column is titled "Sub Category" but often holds a date — kept verbatim
  objection?: string;
  complianceDate?: string;
  receiptDate?: string;
}

export interface FiledDocument {   // "Document Details" table (filings, not orders)
  srNo?: string;
  documentNo?: string;
  receivedDate?: string;     // ISO
  filedBy?: string;
  advocate?: string;
  documentFiled?: string;
}

export interface LinkedCase {
  relation: "main" | "sub";
  filingNumber: string;
}

export interface LowerCourt {      // "Subordinate Court" / "Trial Court Information"
  courtName?: string;
  caseNumber?: string;
  decisionDate?: string;     // ISO
  state?: string;
  district?: string;
}

export interface Classification { name: string; code?: string }

export interface CaseResult {
  // identity
  sourceCaseId?: string;     // stable key for cases without a CNR: "<bench>:<filing no>"
  cnr?: string;              // normalised: upper-case, no dashes
  caseType?: string;
  caseNumber?: string;
  year?: string;
  filingNumber?: string;
  filingDate?: string;       // legacy raw text
  registrationNumber?: string;
  registrationDate?: string; // ISO
  court?: string;
  benchCode?: string;        // our bench key, e.g. KRHC
  courtCode?: string;        // establishment code from the CNR (2 digits)
  state?: string;
  district?: string;
  // status
  status?: string;
  stage?: string;
  decisionDate?: string;     // ISO
  natureOfDisposal?: string;
  firstHearingDate?: string; // ISO
  nextHearingDate?: string;  // ISO
  nextDate?: string;         // legacy raw text
  category?: Classification;
  subCategory?: Classification;
  benchType?: string;
  judicialBranch?: string;
  judge?: string;
  // people
  parties: Party[];
  advocates: Advocate[];
  // law
  acts?: string[];           // legacy: "Act s.sections"
  actsStructured?: Act[];
  fir?: string;              // legacy single string
  firDetails?: Fir;
  // history / documents
  hearings: Hearing[];
  documents: Document[];
  orders?: Order[];
  iaApplications?: IaApplication[];
  objections?: Objection[];
  filings?: FiledDocument[];
  linkedCases?: LinkedCase[];
  lowerCourts?: LowerCourt[];
  // bookkeeping
  courtData?: Record<string, unknown>;  // source-specific passthrough (court_data jsonb)
  warnings?: string[];                  // e.g. "selectors unverified"
  fetchedAt?: string;
  caseDurationDays?: number;            // filing (else registration) → decision date, or → today while pending
  contentHash?: string;                 // sha256 of the case content (change detection)
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
