/**
 * Wire types for the routes this package calls.
 *
 * The generator (A04) emits `openapi.json` and an index of operation ids, method
 * and path — enough to prove a route exists, not enough to type its body. Until
 * the generator emits schemas, the bodies are declared here, next to the endpoint
 * that uses them, and `contract.test.ts` asserts every declared endpoint still
 * matches the generated index. A route that changes shape therefore fails a test
 * rather than a user.
 */

/** CONTRACTS §5: the `kind` claim. */
export type ClientKind = "web" | "desktop" | "bridge" | "premiere" | "ae" | "resolve" | "api";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

/** D60: the jurisdictions with their own minimum age. */
export type Jurisdiction = "IN" | "EU" | "OTHER";

/** The purposes `consent_records` knows about (A05). All default false. */
export type ConsentPurpose = "analytics" | "memory" | "marketing" | "share_upload" | "affiliate";

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  "analytics",
  "memory",
  "marketing",
  "share_upload",
  "affiliate",
];

/** The three a sign-up form asks about. */
export interface Consents {
  analytics?: boolean;
  memory?: boolean;
  marketing?: boolean;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Seconds. The access token lives 15 minutes (CONTRACTS §5). */
  expiresIn: number;
  tokenType: "Bearer";
  sessionId: string;
  workspaceId: string;
  role: WorkspaceRole;
  kind: ClientKind;
}

/** Sign-up always answers 202, whether or not the address already exists. */
export interface SignUpResponse {
  status: "verification_sent";
  email: string;
}

export interface SignUpRequest {
  email: string;
  password: string;
  name?: string;
  locale?: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
  jurisdiction: Jurisdiction;
  consents?: Consents;
}

export interface LoginRequest {
  email: string;
  password: string;
  kind?: ClientKind;
}

export interface MagicLinkResponse {
  status: "sent";
}

export interface SessionSummary {
  id: string;
  kind: ClientKind;
  workspaceId: string;
  ip: string | null;
  ua: string | null;
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string;
  /** The session the calling token belongs to. */
  current: boolean;
}

export interface OAuthCompleteRequest {
  code: string;
  dateOfBirth?: string;
  jurisdiction?: Jurisdiction;
  consents?: Consents;
}

/** What the device-approval screen shows (THREAT-MODEL T3). */
export interface PendingApproval {
  userCode: string;
  clientKind: ClientKind;
  hostApp: "web" | "desktop" | "premiere" | "ae" | "resolve" | null;
  deviceInfo: Record<string, unknown>;
  ip: string | null;
  location: { country?: string; region?: string; city?: string } | null;
  expiresAt: string;
}

export interface DeviceApproveRequest {
  userCode: string;
  workspaceId?: string;
  decision?: "approve" | "deny";
}

// --- Users, workspaces, consents and rights (A05) ---------------------------

/**
 * `onboarding` is a free-form object on the user (A05), which is where F-002's
 * answers live: what you make, the languages you speak on camera, how you found
 * us. B17 turns them into defaults and attribution events.
 */
export interface OnboardingProfile {
  makes?: string[];
  languages?: string[];
  source?: string;
  referralCode?: string;
  completedAt?: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  locale: string;
  jurisdiction: Jurisdiction;
  /** D60: `minor` switches analytics, streaks, referral and affiliate off. */
  ageBracket: "adult" | "minor";
  marketingOptIn: boolean;
  onboarding: OnboardingProfile & Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  /** The workspace the calling token names, and the caller's role in it. */
  workspace: { id: string; role: WorkspaceRole };
}

export interface UpdateMeRequest {
  name?: string | null;
  avatarUrl?: string | null;
  locale?: string;
  marketingOptIn?: boolean;
  onboarding?: Record<string, boolean | number | string | string[]>;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  type: "personal" | "team" | "agency";
  ownerId: string;
  region: "in" | "eu" | "us";
  currency: "INR" | "USD";
  /** The caller's role in this workspace. */
  role: WorkspaceRole;
  memberCount: number;
  createdAt: string;
}

/**
 * The computed entitlement (A05, cached 60 s server-side).
 *
 * It carries the **allowance**, not the balance: the credit ledger is B02's, so
 * until that lands the meter shows the monthly allowance and no burn rate.
 */
export interface Entitlement {
  workspaceId: string;
  planKey: "free" | "starter" | "creator" | "studio" | "agency";
  planName: string;
  creditsPerMonthTenths: number;
  seatsIncluded: number;
  seatsUsed: number;
  entitlements: Record<string, unknown>;
  computedAt: string;
}

/** Trailing usage, for the burn-rate tooltip. Owned by B02. */
export interface UsageSummary {
  burnRateTenthsPerDay: number;
  creditsRemainingTenths: number;
  resetsAt: string | null;
  streakDays: number;
}

export interface ConsentRecord {
  purpose: ConsentPurpose;
  granted: boolean;
  version: string | null;
  decidedAt: string | null;
  withdrawnAt: string | null;
  /** `false` when the purpose has never been asked about. */
  recorded: boolean;
}

export interface ConsentState {
  noticeVersion: string;
  /** The notice moved on and the user has to be asked again. */
  reconsentRequired: boolean;
  purposes: ConsentRecord[];
}

export interface SetConsentRequest {
  purpose: ConsentPurpose;
  granted: boolean;
}

/** `GET /me/data` and `DELETE /me` both answer with a rights request. */
export interface RightsRequest {
  requestId: string;
  status: "received" | "verifying" | "in_progress" | "completed" | "rejected";
  requestedAt: string;
  dueAt: string;
  downloadUrl?: string;
  expiresAt?: string;
  sizeBytes?: number;
  sessionsRevoked?: number;
}

/** D62: learned memory is opt-in, erasable and carries a rolling TTL. */
export interface MemoryEntry {
  id: string;
  kind: "spelling" | "glossary" | "timing" | "style";
  key: string;
  value: string;
  updatedAt: string;
  expiresAt: string;
}

// --- Projects, folders and media (A06, A14) ---------------------------------

export type ProjectAspect = "9:16" | "16:9" | "1:1" | "4:5";
export type ProjectStatus = "draft" | "active" | "archived";

export interface Project {
  id: string;
  workspaceId: string;
  title: string;
  folderId: string | null;
  clientTag: string | null;
  sourceLanguage: string | null;
  scripts: string[];
  aspect: ProjectAspect;
  status: ProjectStatus;
  thumbnailKey: string | null;
  durationMs: number | null;
  mediaCount: number;
  lastActivityAt: string;
  retentionUntil: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ProjectPage {
  items: Project[];
  nextCursor: string | null;
}

export interface CreateProjectRequest {
  title: string;
  folderId?: string;
  clientTag?: string;
  aspect?: ProjectAspect;
  sourceLanguage?: string;
}

export interface UpdateProjectRequest {
  title?: string;
  folderId?: string | null;
  clientTag?: string | null;
  aspect?: ProjectAspect;
  sourceLanguage?: string | null;
  status?: ProjectStatus;
}

export interface ListProjectsQuery {
  q?: string;
  status?: ProjectStatus;
  /** A folder id, or the literal `"root"` for projects in no folder. */
  folder?: string;
  clientTag?: string;
  cursor?: string;
  limit?: number;
}

export interface BatchCreateProjectsRequest {
  projects: CreateProjectRequest[];
  folderId?: string;
  clientTag?: string;
}

export interface Folder {
  id: string;
  workspaceId: string;
  name: string;
  parentId: string | null;
  position: number;
  projectCount: number;
  createdAt: string;
}

export interface CreateFolderRequest {
  name: string;
  parentId?: string;
  position?: number;
}

export interface UpdateFolderRequest {
  name?: string;
  parentId?: string | null;
  position?: number;
}

export type MediaStatus =
  "pending" | "uploading" | "uploaded" | "probing" | "ready" | "failed" | "purged";

export interface MediaDerivedKeys {
  proxy: string | null;
  audio16k: string | null;
  audio48k: string | null;
  waveform: string | null;
  thumbs: string[];
}

export interface Media {
  id: string;
  projectId: string;
  role: string;
  bucket: "s3" | "r2";
  storageKey: string;
  filename: string | null;
  mime: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  durationMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  audioChannels: number | null;
  status: MediaStatus;
  needsRealign: boolean;
  uploadedAt: string | null;
  rawPurgeAt: string | null;
  derivedPurgeAt: string | null;
  derived: MediaDerivedKeys;
  createdAt: string;
}

export interface InitUploadRequest {
  filename: string;
  size: number;
  mime: string;
  /** Client-computed digest (SHA-256), used to recognise a re-upload. */
  contentHash?: string;
  role?: "primary" | "broll" | "audio";
}

export interface UploadPart {
  partNumber: number;
  url: string;
}

export interface UploadTicket {
  mediaId: string;
  /** `null` when `duplicate` is true. */
  uploadId: string | null;
  key: string;
  bucket: "s3" | "r2";
  partSizeBytes: number;
  parts: UploadPart[];
  expiresAt: string | null;
  duplicate: boolean;
  media: Media;
}

export interface CompleteUploadRequest {
  /** `ETag` response headers of the part uploads, in part order. */
  etags: string[];
}

export interface CompletedUpload {
  media: Media;
  probeJobId: string;
  proxyJobId: string | null;
}

export interface MediaUrls {
  mediaId: string;
  proxy?: string;
  audio16k?: string;
  audio48k?: string;
  waveform?: string;
  thumbs: string[];
  expiresAt: string;
}

// --- Jobs (A08, A14) ---------------------------------------------------------

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobSummary {
  id: string;
  type: string;
  status: JobStatus;
  priority: number;
  /** 0-100. */
  progress: number;
  etaMs: number | null;
  projectId: string | null;
  jobKey: string;
  attemptId: string | null;
  creditsChargedTenths: number;
  maxQueueWaitMs: number | null;
  result: unknown;
  error: { code?: string; message?: string; retryable?: boolean } | null;
  provider: string | null;
  model: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobPage {
  items: JobSummary[];
  nextCursor: string | null;
}

export interface ListJobsQuery {
  projectId?: string;
  status?: JobStatus;
  type?: string;
  cursor?: string;
  limit?: number;
}

// --- Styles (A16, A14) -------------------------------------------------------

/**
 * One catalogue entry: every `StyleDoc` v2 field (07 §Styles), plus where it
 * came from. `@montaj/caption-styles` — which already depends on nothing this
 * package should — owns the authoritative `StyleDoc` shape and the type the web
 * app casts a fetched entry to; this client only declares the fields it and a
 * quick-pick need to route and to render without pulling a rendering package
 * into a generic HTTP client.
 */
export interface StyleCatalogueEntry {
  id: string;
  name: string;
  version: 2;
  category: string;
  minPlan: "free" | "starter" | "creator" | "studio" | "agency";
  /** The `style_presets` row id — never the same as `id` (the catalogue key). */
  presetId: string;
  source: "system" | "custom";
  /** `null` for a system style. */
  workspaceId: string | null;
  /** Filename under the web app's own `/style-previews/`, or `null`. */
  previewKey: string | null;
  /** Typography, colours, animation, ... — the rest of StyleDoc v2. */
  [key: string]: unknown;
}

/** `POST /workspaces/{id}/style-presets` and the `PATCH` that follows it. */
export interface StylePresetRequest {
  /** A full StyleDoc v2 document; validated server-side (D64 naming rule too). */
  doc: Record<string, unknown>;
}

// --- Transcripts (A11, A14) --------------------------------------------------

interface TranscribeCaptionPreferences {
  maxLines?: number;
  minMs?: number;
  maxMs?: number;
  maxChars?: number;
  dropFillers?: boolean;
  styleRef?: string;
}

/** `POST /projects/{id}/transcribe` and `/transcript/retranscribe`'s shared body. */
export interface TranscribeRequest {
  /** Language hints, best first; the first is passed to the provider. */
  languages?: string[];
  /** Glossary terms: hotword prompts where the provider supports them. */
  hints?: string[];
  /** Free — the transcription rate includes diarisation. */
  diarise?: boolean;
  captions?: TranscribeCaptionPreferences;
}

export interface TranscriptionQuote {
  /** Credits held before the job was enqueued, in tenths. */
  tenths: number;
  /** For display only, never for arithmetic. */
  credits: string;
  durationMs: number;
}

export interface TranscribeAccepted {
  /** Poll `GET /jobs/{id}` or listen for `job.completed`. */
  jobId: string;
  /** The transcript the completion will write. */
  transcriptId: string;
  /** `queued`, or the live job's status when deduplicated. */
  status: string;
  /** True when a transcription was already running and none was enqueued. */
  deduplicated: boolean;
  quote: TranscriptionQuote;
}

// ---------------------------------------------------------------------------
// Offers (B04): signup gift, ₹9 clean export, week pass, ₹149 Free top-up.
// ---------------------------------------------------------------------------

export type Currency = "INR" | "USD";

export type NinePassIneligibleReason =
  "currency_not_inr" | "on_paid_plan" | "purchased_within_30_days";

export interface NinePassEligibilityView {
  /** An unconsumed, paid pass exists right now — a clean export is available. */
  available: boolean;
  /** May the workspace start a *new* checkout for one? (independent of `available`.) */
  eligibleToBuy: boolean;
  reason: NinePassIneligibleReason | null;
  nextEligibleAt: string | null;
  priceMinor: number;
  currency: Currency;
}

export interface WeekPassEligibilityView {
  active: boolean;
  endsAt: string | null;
  priceMinor: number;
  currency: Currency;
  creditsGrantedTenths: number;
  days: number;
}

export interface TopupEligibilityView {
  available: boolean;
  priceMinor: number;
  currency: Currency;
  credits: number;
}

export interface OffersEligibilityView {
  signupGift: { available: boolean };
  ninePass: NinePassEligibilityView;
  weekPass: WeekPassEligibilityView;
  topupFree149: TopupEligibilityView;
}

export type PassKind = "first_export" | "week_pass" | "pay_once" | "topup";
export type PassStatus = "pending_payment" | "available" | "active" | "redeemed" | "expired";

export interface PassView {
  id: string;
  kind: PassKind;
  status: PassStatus;
  startsAt: string;
  endsAt: string | null;
  creditsGrantedTenths: number;
  redeemedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Billing (B01): plan checkout, passes/top-ups, subscription.
// ---------------------------------------------------------------------------

export type PlanKey = "free" | "starter" | "creator" | "studio" | "agency";
export type BillingInterval = "month" | "year" | "halfyear" | "once";

export interface PassCheckoutRequest {
  kind: "first_export" | "week_pass" | "pay_once";
  /** Required for `pay_once` (whose plan's credit allotment is being bought). */
  planKey?: PlanKey;
}

export interface TopupCheckoutRequest {
  credits: number;
}

export interface PassCheckoutResponse {
  passPurchaseId: string;
  /** Razorpay Checkout key id — `undefined` against the fake provider. */
  keyId: string;
  providerOrderId: string;
  amountMinor: number;
  currency: Currency;
  creditsGrantedTenths: number;
}

/** `GET /streak` (B06). `eligible:false` when the flag is off, the caller is a
 * declared minor, or the workspace is not otherwise in the experiment. */
export interface StreakView {
  eligible: boolean;
  /** `true` for the holdout arm — the caller should still never render a reward for it. */
  holdout: boolean;
  creditsOnly: boolean;
  level: number;
  publishDaysThisWeek: number;
  bar: number;
  paused: boolean;
  freezesRemaining: number;
  consecutiveWeeks: number;
  weekWindowStart: string;
  weekWindowEnd: string;
  nextRewardLabel: string | null;
  discountPercent: number;
  creditGrantTenths: number;
}

export interface SubscriptionView {
  id: string;
  planKey: PlanKey;
  status: string;
  interval: BillingInterval;
  currency: Currency;
  listPriceMinor: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  renewalInitiateAt: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  pausedUntil: string | null;
  seats: number;
  mandateId: string | null;
}

/** `GET /workspaces/{id}/credits` (B02). */
export interface CreditsSummary {
  workspaceId: string;
  balanceTenths: number;
  monthlyGrantTenths: number;
  grantResetAt: string | null;
  lots: { id: string; source: string; remainingTenths: number; expiresAt: string | null }[];
}

// ---------------------------------------------------------------------------
// Scripts and translation (A22)
// ---------------------------------------------------------------------------

/** `POST /projects/{id}/transcript/transliterate`. */
export interface TransliterateRequest {
  script: "roman" | "native";
}

export interface TransliterateAccepted {
  jobId: string;
  targetScript: "roman" | "native";
  status: string;
  deduplicated: boolean;
}

/** `POST /projects/{id}/transcript/translate`. */
export interface TranslateRequest {
  targets: string[];
  mode?: "segment";
}

export interface TranslationQuote {
  tenths: number;
  credits: string;
}

export interface TranslateTargetAccepted {
  jobId: string;
  targetLanguage: string;
  status: string;
  deduplicated: boolean;
  quote: TranslationQuote;
}

export interface TranslateAccepted {
  targets: TranslateTargetAccepted[];
  quote: TranslationQuote;
}

/** One row of `GET /projects/{id}/transcript/scripts`. */
export interface ScriptAvailability {
  script: "roman" | "native" | "en" | "translated";
  available: boolean;
  source?: "transcription" | "transliteration" | "translation";
  provider?: string | null;
  /** For `translated`: the BCP-47 target it currently holds. */
  language?: string;
  updatedAt?: string;
}

export interface AvailableScripts {
  scripts: ScriptAvailability[];
}

// --- Billing (B01) ------------------------------------------------------------

/**
 * `GET /billing/plans` (B01, public — no auth required). One entry per active
 * plan; `prices`/`seatPrice` are in minor units (paise/cents) keyed by ISO
 * currency then interval (`month`, `year`, and `halfyear` for Studio/INR
 * only — `hasHalfyear` says which currency actually carries one).
 */
export interface PlanCatalogueEntry {
  key: "free" | "starter" | "creator" | "studio" | "agency";
  name: string;
  prices: Record<string, Record<string, number>>;
  creditsPerMonthTenths: number;
  seatPrice: Record<string, number> | null;
  hasHalfyear: { INR: boolean; USD: boolean };
}
