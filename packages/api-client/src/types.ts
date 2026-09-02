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

/** The consent purposes `consent_records` knows about. All default false. */
export interface Consents {
  analytics?: boolean;
  memory?: boolean;
  marketing?: boolean;
}

export type ConsentPurpose = keyof Consents;

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ["analytics", "memory", "marketing"];

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

// --- A05 surface (users, workspaces, consents, memory) ----------------------
// Declared here so the shell is written against the real contract of
// `07-api-and-contracts.md`; `endpoints/pending.ts` records that the routes are
// not in the generated index yet.

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  locale: string | null;
  /** D60: `minor` switches analytics, streaks, referral and affiliate off. */
  ageBracket: "adult" | "minor";
  emailVerified: boolean;
  onboardingCompletedAt: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  plan: string;
}

export interface Entitlement {
  plan: string;
  /** Credits are integer tenths (CONTRACTS §0). */
  creditsRemainingTenths: number;
  creditsIncludedTenths: number;
  resetsAt: string | null;
  features: Record<string, boolean>;
}

export interface UsageSummary {
  /** Tenths spent per day over the trailing week, for the burn-rate tooltip. */
  burnRateTenthsPerDay: number;
  streakDays: number;
}

export interface ConsentRecord {
  purpose: ConsentPurpose;
  granted: boolean;
  version: string;
  decidedAt: string;
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

export interface OnboardingProfile {
  /** F-002 step 1 — "What do you make?" */
  makes?: string[];
  /** F-002 step 2 — languages spoken on camera; Hinglish first. */
  languages?: string[];
  /** F-002 step 3 — attribution. */
  source?: string;
  referralCode?: string;
}
