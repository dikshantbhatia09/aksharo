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
