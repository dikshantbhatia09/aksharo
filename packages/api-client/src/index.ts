/**
 * `@montaj/api-client` — the typed API surface every Aksharo client uses.
 *
 * Three layers, and each one is replaceable without touching the others:
 *
 *   generated/   `pnpm gen:client` writes `openapi.json` and the operation index
 *                from the API's own Swagger output (A04 built the generator).
 *   endpoints    typed descriptors — method, path, auth, request and response —
 *                checked against the generated index by `contract.test.ts`.
 *   hooks        TanStack Query over those descriptors, plus the realtime client.
 *
 * The fetch layer owns the bearer header, the CONTRACTS §8 error envelope and
 * the single-flight refresh; it owns no storage, because where the refresh token
 * lives is a property of the surface (httpOnly cookie in the browser, keychain
 * on the desktop, nothing at all in a panel).
 */

export { API_OPERATIONS, API_VERSION, findOperation } from "./generated/operations.js";
export type { ApiOperation, ApiOperationId } from "./generated/operations.js";

export {
  ApiError,
  AUTH_ERROR_CODES,
  CLIENT_ERROR_CODES,
  hasErrorCode,
  isApiError,
  parseErrorEnvelope,
} from "./errors.js";
export type { ErrorEnvelope } from "./errors.js";

export { ApiClient, createApiClient, defineEndpoint } from "./http.js";
export type {
  ApiClientOptions,
  CallOptions,
  EndpointSpec,
  HttpMethod,
  RequestOf,
  ResponseOf,
} from "./http.js";

export {
  ALL_ENDPOINTS,
  authEndpoints,
  billingEndpoints,
  creditsEndpoints,
  deviceEndpoints,
  endpoints,
  folderEndpoints,
  jobEndpoints,
  offersEndpoints,
  mediaEndpoints,
  memoryEndpoints,
  pendingEndpoints,
  projectEndpoints,
  styleEndpoints,
  transcriptEndpoints,
  transcriptScriptsEndpoints,
} from "./endpoints.js";

export { decodeAccessToken, REFRESH_SKEW_MS, SessionStore } from "./session.js";
export type { SessionSnapshot } from "./session.js";

export { queryKeys } from "./query-keys.js";
export type { QueryKeys } from "./query-keys.js";

export { ApiProvider, useApiClient, useApiContext, useSession, useWorkspaceId } from "./context.js";
export type { ApiContextValue } from "./context.js";

export * from "./hooks.js";

export {
  backoffDelayMs,
  CLOSE_CODES,
  REALTIME_PROTOCOL,
  RealtimeClient,
  rooms,
} from "./realtime.js";
export type {
  RealtimeClientOptions,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeEventName,
  RealtimeStatus,
  WebSocketLike,
} from "./realtime.js";

export { API_KEY_SCOPES, CONSENT_PURPOSES, WEBHOOK_EVENT_NAMES } from "./types.js";
export type {
  AcademyProgressResponse,
  AcademyTrackProgress,
  ChangelogDismissedResponse,
  CreateSupportTicketRequest,
  ListSupportTicketsResponse,
  MarkStepDoneResult,
  SupportCategory,
  SupportDiagnostics,
  SupportTicketView,
  AffiliatePayoutMethod,
  AffiliateProfile,
  AffiliateStats,
  ApiKeyScope,
  ApiKeyView,
  ApplyAffiliateRequest,
  AttachAffiliateAttributionRequest,
  AttachAffiliateAttributionResult,
  AvailableScripts,
  CreateApiKeyRequest,
  CreatedWebhookEndpointView,
  CreateWebhookRequest,
  MintedApiKeyView,
  UpdateWebhookRequest,
  WebhookDeliveryView,
  WebhookEndpointView,
  WebhookEventName,
  BillingInterval,
  BatchCreateProjectsRequest,
  ClientKind,
  CompletedUpload,
  CompleteUploadRequest,
  ConsentPurpose,
  ConsentRecord,
  Consents,
  ConsentState,
  CreditsSummary,
  Currency,
  CreateFolderRequest,
  CreateMemoryEntryRequest,
  CreateProjectRequest,
  CurrentUser,
  DeviceApproveRequest,
  Entitlement,
  Folder,
  ImportGlossaryRequest,
  ImportGlossaryResult,
  InitUploadRequest,
  InsightJob,
  InsightKind,
  InsightRow,
  InsightsAccepted,
  InsightsRequest,
  InsightsResponse,
  InsightTone,
  JobPage,
  JobStatus,
  JobSummary,
  Jurisdiction,
  ListJobsQuery,
  ListProjectsQuery,
  LoginRequest,
  MagicLinkResponse,
  Media,
  MediaDerivedKeys,
  MediaStatus,
  MediaUrls,
  MemoryEntry,
  MemoryKind,
  NinePassEligibilityView,
  NinePassIneligibleReason,
  OAuthCompleteRequest,
  OffersEligibilityView,
  OnboardingProfile,
  PassCheckoutRequest,
  PassCheckoutResponse,
  PassKind,
  PassStatus,
  PassView,
  PendingApproval,
  PlanKey,
  PlanCatalogueEntry,
  Project,
  ProjectAspect,
  ProjectPage,
  ProjectStatus,
  RecordSpellingFixRequest,
  RecordStylePrefRequest,
  RecordTimingNudgeRequest,
  RightsRequest,
  ScriptAvailability,
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
  TopupEligibilityView,
  TranscribeAccepted,
  TranscribeRequest,
  TranscriptionQuote,
  TranslateAccepted,
  TranslateRequest,
  TranslateTargetAccepted,
  TranslationQuote,
  TransliterateAccepted,
  TransliterateRequest,
  UpdateFolderRequest,
  UpdateMeRequest,
  UpdateMemoryEntryRequest,
  UpdateProjectRequest,
  UploadPart,
  UploadTicket,
  UsageSummary,
  WeekPassEligibilityView,
  WorkspaceRole,
  WorkspaceSummary,
  ChangeRoleRequest,
  ClientTagView,
  CreateLicenseKeyRequest,
  DeviceHost,
  DeviceView,
  InviteMemberRequest,
  LicenseKeyView,
  MemberView,
  MembershipStatus,
  PluginManifestChannel,
  PluginManifestResponse,
  RenameDeviceRequest,
  SetClientTagRequest,
  TransferOwnershipRequest,
  TransferOwnershipResult,
} from "./types.js";

/** Build-time identity of this package, used by diagnostics bundles. */
export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  readonly implementedBy: string;
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/api-client",
  implementedBy:
    "A03 (spec), A04 (generator), A13 (fetch layer + hooks), A14 (projects/media/styles)",
  implemented: true,
};
