/**
 * Every route the web shell calls, as typed endpoint descriptors.
 *
 * Routes carrying an `operationId` are in the generated index and are checked
 * against it by `contract.test.ts`. Routes carrying `pending` are specified in
 * `07-api-and-contracts.md` but their work package has not landed; the client
 * raises `client/not_implemented` for them, and the same contract test asserts
 * they are still absent — so the day the owning work package merges, this file
 * fails a test and gets updated rather than silently continuing to guess. That
 * is not hypothetical: A05 landed between A13's first commit and its merge, and
 * this is how the seven routes below moved.
 */

import { defineEndpoint } from "./http.js";

import type {
  AffiliateProfile,
  AffiliateStats,
  ApplyAffiliateRequest,
  AvailableScripts,
  BatchCreateProjectsRequest,
  ClaimReferralRequest,
  ClaimReferralResult,
  CompletedUpload,
  CompleteUploadRequest,
  ConsentState,
  CreateFolderRequest,
  CreateProjectRequest,
  CreditsSummary,
  CurrentUser,
  DeviceApproveRequest,
  DismissReferralPromptResult,
  Entitlement,
  Folder,
  InitUploadRequest,
  JobPage,
  JobSummary,
  LoginRequest,
  MagicLinkResponse,
  Media,
  MediaUrls,
  MemoryEntry,
  OAuthCompleteRequest,
  OffersEligibilityView,
  PassCheckoutRequest,
  PassCheckoutResponse,
  PassView,
  PendingApproval,
  PlanCatalogueEntry,
  Project,
  ProjectPage,
  ReferralStats,
  RightsRequest,
  SessionSummary,
  SetConsentRequest,
  SignUpRequest,
  SignUpResponse,
  StreakView,
  StyleCatalogueEntry,
  StylePresetRequest,
  SubscriptionView,
  TokenResponse,
  TopupCheckoutRequest,
  TranscribeAccepted,
  TranscribeRequest,
  TranslateAccepted,
  TranslateRequest,
  TransliterateAccepted,
  TransliterateRequest,
  UpdateFolderRequest,
  UpdateMeRequest,
  UpdateProjectRequest,
  UploadTicket,
  UsageSummary,
  WorkspaceSummary,
} from "./types.js";

/** Auth (A04). */
export const authEndpoints = {
  signUp: defineEndpoint<SignUpRequest, SignUpResponse>({
    method: "POST",
    path: "/auth/signup",
    auth: "public",
    operationId: "AuthController_signUp",
  }),
  login: defineEndpoint<LoginRequest, TokenResponse>({
    method: "POST",
    path: "/auth/login",
    auth: "public",
    operationId: "AuthController_login",
  }),
  verifyEmail: defineEndpoint<{ token: string }, { verified: true }>({
    method: "POST",
    path: "/auth/verify-email",
    auth: "public",
    operationId: "AuthController_verifyEmail",
  }),
  requestMagicLink: defineEndpoint<{ email: string }, MagicLinkResponse>({
    method: "POST",
    path: "/auth/magic-link",
    auth: "public",
    operationId: "AuthController_requestMagicLink",
  }),
  consumeMagicLink: defineEndpoint<{ token: string; kind?: string }, TokenResponse>({
    method: "POST",
    path: "/auth/magic-link/consume",
    auth: "public",
    operationId: "AuthController_consumeMagicLink",
  }),
  refresh: defineEndpoint<{ refreshToken: string }, TokenResponse>({
    method: "POST",
    path: "/auth/refresh",
    auth: "public",
    operationId: "AuthController_refresh",
  }),
  logout: defineEndpoint<{ refreshToken: string }, void>({
    method: "POST",
    path: "/auth/logout",
    auth: "public",
    operationId: "AuthController_logout",
  }),
  exchangeWorkspace: defineEndpoint<{ workspaceId: string }, TokenResponse>({
    method: "POST",
    path: "/auth/token/exchange",
    auth: "bearer",
    operationId: "AuthController_exchange",
  }),
  listSessions: defineEndpoint<void, SessionSummary[]>({
    method: "GET",
    path: "/auth/sessions",
    auth: "bearer",
    operationId: "AuthController_listSessions",
  }),
  revokeSession: defineEndpoint<void, void>({
    method: "DELETE",
    path: "/auth/sessions/{sessionId}",
    auth: "bearer",
    operationId: "AuthController_revokeSession",
  }),
  parentalWaitlist: defineEndpoint<{ email: string }, { status: string }>({
    method: "POST",
    path: "/auth/parental-waitlist",
    auth: "public",
    operationId: "AuthController_joinWaitlist",
  }),
  completeOAuth: defineEndpoint<OAuthCompleteRequest, TokenResponse>({
    method: "POST",
    path: "/auth/oauth/complete",
    auth: "public",
    operationId: "OAuthController_complete",
  }),
} as const;

/** Device grant (A04) — RFC 8628, approved from an authenticated web session. */
export const deviceEndpoints = {
  describe: defineEndpoint<void, PendingApproval>({
    method: "GET",
    path: "/auth/device/code/{userCode}",
    auth: "bearer",
    operationId: "DeviceController_describe",
  }),
  decide: defineEndpoint<DeviceApproveRequest, { status: "approved" | "denied" }>({
    method: "POST",
    path: "/auth/device/approve",
    auth: "bearer",
    operationId: "DeviceController_decide",
  }),
} as const;

/** The account, its workspaces and its rights (A05). */
export const accountEndpoints = {
  me: defineEndpoint<void, CurrentUser>({
    method: "GET",
    path: "/me",
    auth: "bearer",
    operationId: "getMe",
  }),
  updateMe: defineEndpoint<UpdateMeRequest, CurrentUser>({
    method: "PATCH",
    path: "/me",
    auth: "bearer",
    operationId: "updateMe",
  }),
  listWorkspaces: defineEndpoint<void, WorkspaceSummary[]>({
    method: "GET",
    path: "/workspaces",
    auth: "bearer",
    operationId: "listWorkspaces",
  }),
  entitlement: defineEndpoint<void, Entitlement>({
    method: "GET",
    path: "/workspaces/{id}/entitlement",
    auth: "bearer",
    operationId: "getWorkspaceEntitlement",
  }),
  listConsents: defineEndpoint<void, ConsentState>({
    method: "GET",
    path: "/consents",
    auth: "bearer",
    operationId: "getConsents",
  }),
  /** One purpose per call: a consent record is per purpose (D60). */
  setConsent: defineEndpoint<SetConsentRequest, ConsentState>({
    method: "POST",
    path: "/consents",
    auth: "bearer",
    operationId: "setConsent",
  }),
  exportData: defineEndpoint<void, RightsRequest>({
    method: "GET",
    path: "/me/data",
    auth: "bearer",
    operationId: "requestMyData",
  }),
  deleteAccount: defineEndpoint<void, RightsRequest>({
    method: "DELETE",
    path: "/me",
    auth: "bearer",
    operationId: "deleteMe",
  }),
} as const;

/**
 * Jobs (A08) — the shell needs them for `JobProgress`, the polling fallback and
 * the realtime resync. `list` is what a project card polls when the realtime
 * channel is off or between events.
 */
export const jobEndpoints = {
  get: defineEndpoint<void, JobSummary>({
    method: "GET",
    path: "/jobs/{id}",
    auth: "bearer",
    operationId: "getJob",
  }),
  list: defineEndpoint<void, JobPage>({
    method: "GET",
    path: "/jobs",
    auth: "bearer",
    operationId: "listJobs",
  }),
  listEvents: defineEndpoint<void, { items: unknown[]; nextCursor: string | null }>({
    method: "GET",
    path: "/jobs/{id}/events",
    auth: "bearer",
    operationId: "listJobEvents",
  }),
  cancel: defineEndpoint<void, JobSummary>({
    method: "POST",
    path: "/jobs/{id}/cancel",
    auth: "bearer",
    operationId: "cancelJob",
  }),
} as const;

/** Projects (A06) — list, create, fetch, update, delete, batch and the sample. */
export const projectEndpoints = {
  list: defineEndpoint<void, ProjectPage>({
    method: "GET",
    path: "/projects",
    auth: "bearer",
    operationId: "listProjects",
  }),
  create: defineEndpoint<CreateProjectRequest, Project>({
    method: "POST",
    path: "/projects",
    auth: "bearer",
    operationId: "createProject",
  }),
  batchCreate: defineEndpoint<BatchCreateProjectsRequest, { created: Project[] }>({
    method: "POST",
    path: "/projects/batch",
    auth: "bearer",
    operationId: "batchCreateProjects",
  }),
  /** "Try with a sample" (08 §Home): a real project, seeded with the sample clip. */
  createSample: defineEndpoint<void, Project>({
    method: "POST",
    path: "/projects/sample",
    auth: "bearer",
    operationId: "createSampleProject",
  }),
  get: defineEndpoint<void, Project>({
    method: "GET",
    path: "/projects/{projectId}",
    auth: "bearer",
    operationId: "getProject",
  }),
  update: defineEndpoint<UpdateProjectRequest, Project>({
    method: "PATCH",
    path: "/projects/{projectId}",
    auth: "bearer",
    operationId: "updateProject",
  }),
  remove: defineEndpoint<void, { id: string }>({
    method: "DELETE",
    path: "/projects/{projectId}",
    auth: "bearer",
    operationId: "deleteProject",
  }),
} as const;

/**
 * Folders (A06). `list` is a bare array — "the whole tree", never paginated —
 * unlike `/projects`, which is cursor-paginated and wraps in `{items,
 * nextCursor}`. The two collections do not share a response shape.
 */
export const folderEndpoints = {
  list: defineEndpoint<void, Folder[]>({
    method: "GET",
    path: "/folders",
    auth: "bearer",
    operationId: "listFolders",
  }),
  create: defineEndpoint<CreateFolderRequest, Folder>({
    method: "POST",
    path: "/folders",
    auth: "bearer",
    operationId: "createFolder",
  }),
  get: defineEndpoint<void, Folder>({
    method: "GET",
    path: "/folders/{folderId}",
    auth: "bearer",
    operationId: "getFolder",
  }),
  update: defineEndpoint<UpdateFolderRequest, Folder>({
    method: "PATCH",
    path: "/folders/{folderId}",
    auth: "bearer",
    operationId: "updateFolder",
  }),
  remove: defineEndpoint<void, { id: string }>({
    method: "DELETE",
    path: "/folders/{folderId}",
    auth: "bearer",
    operationId: "deleteFolder",
  }),
} as const;

/**
 * Media ingest (A06). `init` and `complete` are the two calls a browser makes
 * around the presigned multipart upload; the bytes travel straight to the
 * store between them (`apps/web/lib/upload`, CONTRACTS §6).
 */
export const mediaEndpoints = {
  list: defineEndpoint<void, Media[]>({
    method: "GET",
    path: "/projects/{projectId}/media",
    auth: "bearer",
    operationId: "listProjectMedia",
  }),
  get: defineEndpoint<void, Media>({
    method: "GET",
    path: "/media/{mediaId}",
    auth: "bearer",
    operationId: "getMedia",
  }),
  init: defineEndpoint<InitUploadRequest, UploadTicket>({
    method: "POST",
    path: "/projects/{projectId}/media/init",
    auth: "bearer",
    operationId: "initMediaUpload",
  }),
  complete: defineEndpoint<CompleteUploadRequest, CompletedUpload>({
    method: "POST",
    path: "/projects/{projectId}/media/{mediaId}/complete",
    auth: "bearer",
    operationId: "completeProjectMediaUpload",
  }),
  replace: defineEndpoint<InitUploadRequest, UploadTicket>({
    method: "POST",
    path: "/projects/{projectId}/media/{mediaId}/replace",
    auth: "bearer",
    operationId: "replaceMedia",
  }),
  urls: defineEndpoint<void, MediaUrls>({
    method: "GET",
    path: "/projects/{projectId}/media/{mediaId}/urls",
    auth: "bearer",
    operationId: "getMediaUrls",
  }),
} as const;

/** The style catalogue and a workspace's custom presets (A16, D64, A14). */
export const styleEndpoints = {
  list: defineEndpoint<void, StyleCatalogueEntry[]>({
    method: "GET",
    path: "/styles",
    auth: "bearer",
    operationId: "listStyles",
  }),
  createPreset: defineEndpoint<StylePresetRequest, StyleCatalogueEntry>({
    method: "POST",
    path: "/workspaces/{id}/style-presets",
    auth: "bearer",
    operationId: "createStylePreset",
  }),
  updatePreset: defineEndpoint<StylePresetRequest, StyleCatalogueEntry>({
    method: "PATCH",
    path: "/workspaces/{id}/style-presets/{presetId}",
    auth: "bearer",
    operationId: "updateStylePreset",
  }),
  deletePreset: defineEndpoint<void, { id: string }>({
    method: "DELETE",
    path: "/workspaces/{id}/style-presets/{presetId}",
    auth: "bearer",
    operationId: "deleteStylePreset",
  }),
} as const;

/**
 * Transcripts (A11). `transcribe` quotes the job from the probed media
 * duration, holds credits and enqueues `ai.transcribe`; a `transcript/
 * media_not_ready` conflict means the media hasn't been probed yet, which the
 * upload engine's best-effort `tryStartTranscription()` treats the same as
 * any other failure here — the upload is still a complete success, and the
 * project starts transcribing itself once probing catches up (watch
 * `job.completed`, or `GET /jobs/{id}`).
 */
export const transcriptEndpoints = {
  transcribe: defineEndpoint<TranscribeRequest, TranscribeAccepted>({
    method: "POST",
    path: "/projects/{projectId}/transcribe",
    auth: "bearer",
    operationId: "transcribeProject",
  }),
} as const;

/** Billing (B01, B04). Plan catalogue is public; checkout/subscription need a session. */
export const billingEndpoints = {
  listPlans: defineEndpoint<void, PlanCatalogueEntry[]>({
    method: "GET",
    path: "/billing/plans",
    auth: "public",
    operationId: "listPlans",
  }),
  getSubscription: defineEndpoint<void, SubscriptionView | null>({
    method: "GET",
    path: "/billing/subscription",
    auth: "bearer",
    operationId: "getSubscription",
  }),
  createPassCheckout: defineEndpoint<PassCheckoutRequest, PassCheckoutResponse>({
    method: "POST",
    path: "/billing/passes/checkout",
    auth: "bearer",
    operationId: "createPassCheckout",
  }),
  createTopupCheckout: defineEndpoint<TopupCheckoutRequest, PassCheckoutResponse>({
    method: "POST",
    path: "/billing/topups/checkout",
    auth: "bearer",
    operationId: "createTopupCheckout",
  }),
} as const;

/** The streak experiment (B06): sidebar chip and Subscription widget. */
export const streakEndpoints = {
  getStreak: defineEndpoint<void, StreakView>({
    method: "GET",
    path: "/streak",
    auth: "bearer",
    operationId: "getStreak",
  }),
} as const;

/** Credits (B02) — only the balance summary; usage history is out of scope here. */
export const creditsEndpoints = {
  getBalance: defineEndpoint<void, CreditsSummary>({
    method: "GET",
    path: "/workspaces/{id}/credits",
    auth: "bearer",
    operationId: "getWorkspaceCredits",
  }),
} as const;

/**
 * Offers (B04): the signup gift / ₹9 clean export / week pass / ₹149 Free
 * top-up read model the export-dialog upsell panel and the Subscription
 * overview's pass chips render from.
 */
export const offersEndpoints = {
  eligibility: defineEndpoint<void, OffersEligibilityView>({
    method: "GET",
    path: "/offers/eligibility",
    auth: "bearer",
    operationId: "getOffersEligibility",
  }),
  listPasses: defineEndpoint<void, PassView[]>({
    method: "GET",
    path: "/offers/passes",
    auth: "bearer",
    operationId: "listOffersPasses",
  }),
} as const;

/**
 * The give-get referral loop (B07b): the personal code, claim-at-onboarding,
 * and the give-get sheet's "shown once" marker.
 */
export const referralsEndpoints = {
  me: defineEndpoint<void, ReferralStats>({
    method: "GET",
    path: "/referrals/me",
    auth: "bearer",
    operationId: "getReferralsMe",
  }),
  claim: defineEndpoint<ClaimReferralRequest, ClaimReferralResult>({
    method: "POST",
    path: "/referrals/claim",
    auth: "bearer",
    operationId: "claimReferral",
  }),
  markPromptShown: defineEndpoint<void, DismissReferralPromptResult>({
    method: "POST",
    path: "/referrals/prompt/shown",
    auth: "bearer",
    operationId: "markReferralPromptShown",
  }),
} as const;

/** Scripts and translation (A22): `apps/api/src/transcripts/scripts`. */
export const transcriptScriptsEndpoints = {
  transliterate: defineEndpoint<TransliterateRequest, TransliterateAccepted>({
    method: "POST",
    path: "/projects/{projectId}/transcript/transliterate",
    auth: "bearer",
    operationId: "transliterateProjectTranscript",
  }),
  translate: defineEndpoint<TranslateRequest, TranslateAccepted>({
    method: "POST",
    path: "/projects/{projectId}/transcript/translate",
    auth: "bearer",
    operationId: "translateProjectTranscript",
  }),
  scripts: defineEndpoint<void, AvailableScripts>({
    method: "GET",
    path: "/projects/{projectId}/transcript/scripts",
    auth: "bearer",
    operationId: "getProjectTranscriptScripts",
  }),
} as const;

/**
 * Routes `07-api-and-contracts.md` specifies whose work package has not landed.
 *
 * `/usage` carries the credit balance and the burn rate, which belong to the
 * ledger (B02); `/memory` is the learned-memory store of D62 (B09).
 */
export const pendingEndpoints = {
  usage: defineEndpoint<void, UsageSummary>({
    method: "GET",
    path: "/usage",
    auth: "bearer",
    pending: "B02",
  }),
  listMemory: defineEndpoint<void, MemoryEntry[]>({
    method: "GET",
    path: "/memory",
    auth: "bearer",
    pending: "B09",
  }),
  clearMemory: defineEndpoint<void, void>({
    method: "DELETE",
    path: "/memory",
    auth: "bearer",
    pending: "B09",
  }),
} as const;

/** Affiliate v2 (B07). `apply`/`me`/`stats` are scoped to the caller's own affiliate profile. */
export const affiliateEndpoints = {
  apply: defineEndpoint<ApplyAffiliateRequest, AffiliateProfile>({
    method: "POST",
    path: "/affiliate/apply",
    auth: "bearer",
    operationId: "applyAffiliate",
  }),
  /** Wrapped `{ affiliate }` — see `hooks.ts useMyAffiliate`'s doc-comment for why. */
  me: defineEndpoint<void, { affiliate: AffiliateProfile | null }>({
    method: "GET",
    path: "/affiliate/me",
    auth: "bearer",
    operationId: "getMyAffiliate",
  }),
  stats: defineEndpoint<void, AffiliateStats>({
    method: "GET",
    path: "/affiliate/me/stats",
    auth: "bearer",
    operationId: "getMyAffiliateStats",
  }),
} as const;

export const endpoints = {
  auth: authEndpoints,
  device: deviceEndpoints,
  account: accountEndpoints,
  jobs: jobEndpoints,
  projects: projectEndpoints,
  folders: folderEndpoints,
  media: mediaEndpoints,
  styles: styleEndpoints,
  transcripts: transcriptEndpoints,
  transcriptScripts: transcriptScriptsEndpoints,
  billing: billingEndpoints,
  affiliate: affiliateEndpoints,
  credits: creditsEndpoints,
  offers: offersEndpoints,
  referrals: referralsEndpoints,
  streak: streakEndpoints,
  pending: pendingEndpoints,
} as const;

/** Flat list, for the contract test. */
export const ALL_ENDPOINTS = [
  ...Object.entries(authEndpoints),
  ...Object.entries(deviceEndpoints),
  ...Object.entries(accountEndpoints),
  ...Object.entries(jobEndpoints),
  ...Object.entries(projectEndpoints),
  ...Object.entries(folderEndpoints),
  ...Object.entries(mediaEndpoints),
  ...Object.entries(styleEndpoints),
  ...Object.entries(transcriptEndpoints),
  ...Object.entries(transcriptScriptsEndpoints),
  ...Object.entries(billingEndpoints),
  ...Object.entries(affiliateEndpoints),
  ...Object.entries(creditsEndpoints),
  ...Object.entries(offersEndpoints),
  ...Object.entries(referralsEndpoints),
  ...Object.entries(pendingEndpoints),
] as const;
