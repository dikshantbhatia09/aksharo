"use client";

/**
 * TanStack Query hooks over the typed endpoints.
 *
 * The rules that apply to all of them:
 *  - a query that needs a workspace is keyed by the workspace id, so switching
 *    workspaces cannot show the previous one's numbers;
 *  - `client/not_implemented` (a route whose work package has not landed)
 *    resolves to a fallback rather than an error toast, so the shell renders
 *    honestly today and lights up when the work package merges;
 *  - nothing retries a 4xx. Retrying an `auth/expired` is the client's job (the
 *    fetch layer already rotated), retrying a 403 is noise.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient, useApiContext, useWorkspaceId } from "./context.js";
import { endpoints } from "./endpoints.js";
import { ApiError, CLIENT_ERROR_CODES, isApiError } from "./errors.js";
import { queryKeys } from "./query-keys.js";

import type { ApiClient } from "./http.js";
import type {
  AcademyProgressResponse,
  ChangelogDismissedResponse,
  CreateSupportTicketRequest,
  ListSupportTicketsResponse,
  MarkStepDoneResult,
  SupportTicketView,
  ConfirmDiagnosticsBundleResponse,
  AffiliateProfile,
  AffiliateStats,
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
  BatchCreateProjectsRequest,
  ClaimReferralRequest,
  ClaimReferralResult,
  CompleteUploadRequest,
  CompletedUpload,
  ConsentPurpose,
  ConsentState,
  InsightsAccepted,
  InsightsRequest,
  InsightsResponse,
  CreateFolderRequest,
  CreateMemoryEntryRequest,
  CreateProjectRequest,
  CreditsSummary,
  CurrentUser,
  DismissReferralPromptResult,
  Entitlement,
  Folder,
  ImportGlossaryRequest,
  ImportGlossaryResult,
  InitUploadRequest,
  JobPage,
  JobSummary,
  ListProjectsQuery,
  LoginRequest,
  Media,
  MemoryEntry,
  OAuthCompleteRequest,
  OffersEligibilityView,
  OnboardingProfile,
  PassCheckoutRequest,
  PassCheckoutResponse,
  PassView,
  PendingApproval,
  Project,
  ProjectPage,
  RecordSpellingFixRequest,
  RecordStylePrefRequest,
  RecordTimingNudgeRequest,
  ReferralStats,
  RightsRequest,
  SessionSummary,
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
  UpdateMemoryEntryRequest,
  UpdateProjectRequest,
  UploadTicket,
  UsageSummary,
  WorkspaceSummary,
  ChangeRoleRequest,
  ClientTagView,
  CreateLicenseKeyRequest,
  DeviceView,
  InviteMemberRequest,
  LicenseKeyView,
  MemberView,
  MembershipStatus,
  PluginManifestResponse,
  TransferOwnershipRequest,
  TransferOwnershipResult,
} from "./types.js";
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";

/**
 * Never retry a failure the server has already decided on.
 *
 * Typed against `Error` rather than `unknown` so TanStack infers `TError = Error`
 * for every query that uses it; with `unknown` the whole hook signature widens.
 */
function retryPolicy(failureCount: number, error: Error): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * Resolve a call on a route whose work package has not landed to `fallback`.
 *
 * The alternative — letting `client/not_implemented` reach the UI — would put an
 * error state on part of the shell for the weeks between two work packages, and
 * would train everyone to ignore it.
 */
async function withPendingFallback<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.code === CLIENT_ERROR_CODES.notImplemented) {
      return fallback;
    }
    throw error;
  }
}

// --- Session and account ----------------------------------------------------

export function useCurrentUser(): UseQueryResult<CurrentUser> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.me(),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.account.me),
  });
}

export function useUpdateMe(): UseMutationResult<CurrentUser, Error, UpdateMeRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeRequest) => client.call(endpoints.account.updateMe, { body }),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.me(), user);
    },
  });
}

export function useWorkspaces(): UseQueryResult<WorkspaceSummary[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.workspaces(),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.account.listWorkspaces),
  });
}

export function useEntitlement(): UseQueryResult<Entitlement> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.entitlement(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    // 07 §Workspaces caches the computed entitlement for 60 s server-side; the
    // client matching that avoids a request per navigation for a number that
    // cannot have changed.
    staleTime: 60_000,
    retry: retryPolicy,
    queryFn: () =>
      client.call(endpoints.account.entitlement, { params: { id: workspaceId ?? "" } }),
  });
}

/** The credit balance and burn rate. Empty until the ledger (B02) lands. */
export function useUsage(): UseQueryResult<UsageSummary | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.usage(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    staleTime: 300_000,
    retry: retryPolicy,
    queryFn: () => withPendingFallback(() => client.call(endpoints.pending.usage), null),
  });
}

export function useSessions(): UseQueryResult<SessionSummary[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.sessions(),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.auth.listSessions),
  });
}

export function useRevokeSession(): UseMutationResult<void, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      client.call(endpoints.auth.revokeSession, { params: { sessionId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions() }),
  });
}

// --- Consents, memory and rights (D60, D62) --------------------------------

export function useConsents(): UseQueryResult<ConsentState> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.consents(),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.account.listConsents),
  });
}

/** One purpose per call: a consent record is per purpose, refusals included. */
export function useSetConsent(): UseMutationResult<
  ConsentState,
  Error,
  { purpose: ConsentPurpose; granted: boolean }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.account.setConsent, { body }),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.consents(), state);
    },
  });
}

/** D62: only readable once the memory consent exists, so the caller gates it. */
export function useMemoryEntries(enabled: boolean): UseQueryResult<MemoryEntry[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.memory(),
    enabled: enabled && workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.memory.list),
  });
}

export function useCreateMemoryEntry(): UseMutationResult<
  MemoryEntry,
  Error,
  CreateMemoryEntryRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMemoryEntryRequest) => client.call(endpoints.memory.create, { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

export function useUpdateMemoryEntry(): UseMutationResult<
  MemoryEntry,
  Error,
  { id: string; body: UpdateMemoryEntryRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => client.call(endpoints.memory.update, { params: { id }, body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

export function useDeleteMemoryEntry(): UseMutationResult<void, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.call(endpoints.memory.remove, { params: { id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

export function useClearMemory(): UseMutationResult<void, Error, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.call(endpoints.memory.clear),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

export function useImportMemoryGlossary(): UseMutationResult<
  ImportGlossaryResult,
  Error,
  ImportGlossaryRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportGlossaryRequest) =>
      client.call(endpoints.memory.importGlossary, { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

// --- Learning hooks (B09b) --------------------------------------------------

/**
 * A15's "Fix spelling everywhere" → `POST /memory/hooks/spelling-fix`. The
 * caller is responsible for the consent gate (`readPrivacy().memory`) and for
 * calling this only after the correction's own op batch has been
 * acknowledged (`editor-client.tsx`) — a memory write is a side effect of a
 * successful edit, never a precondition for one.
 */
export function useRecordSpellingFixMemory(): UseMutationResult<
  MemoryEntry | undefined,
  Error,
  RecordSpellingFixRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordSpellingFixRequest) =>
      client.call(endpoints.memory.recordSpellingFix, { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

/**
 * A17/A02d's timing-nudge sink → `POST /memory/hooks/timing-nudge`. Callers
 * debounce per drag and are consent-gated the same way
 * (`useRecordSpellingFixMemory`'s doc-comment); this hook itself fires
 * unconditionally, exactly once per `mutate()` call.
 */
export function useRecordTimingNudgeMemory(): UseMutationResult<
  MemoryEntry,
  Error,
  RecordTimingNudgeRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordTimingNudgeRequest) =>
      client.call(endpoints.memory.recordTimingNudge, { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

/** Last style/template used per aspect ratio → `POST /memory/hooks/style-pref`. */
export function useRecordStylePrefMemory(): UseMutationResult<
  MemoryEntry,
  Error,
  RecordStylePrefRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordStylePrefRequest) =>
      client.call(endpoints.memory.recordStylePref, { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memory() }),
  });
}

export function useExportMyData(): UseMutationResult<RightsRequest, Error, void> {
  const client = useApiClient();
  return useMutation({ mutationFn: () => client.call(endpoints.account.exportData) });
}

export function useDeleteAccount(): UseMutationResult<RightsRequest, Error, void> {
  const client = useApiClient();
  return useMutation({ mutationFn: () => client.call(endpoints.account.deleteAccount) });
}

// --- Auth flows -------------------------------------------------------------

export function useSignUp(): UseMutationResult<SignUpResponse, Error, SignUpRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: SignUpRequest) => client.call(endpoints.auth.signUp, { body }),
  });
}

export function useRequestMagicLink(): UseMutationResult<{ status: "sent" }, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (email: string) =>
      client.call(endpoints.auth.requestMagicLink, { body: { email } }),
  });
}

export function useJoinParentalWaitlist(): UseMutationResult<{ status: string }, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (email: string) =>
      client.call(endpoints.auth.parentalWaitlist, { body: { email } }),
  });
}

/**
 * Sign in. The token pair is handed to `onTokens` — normally the shell's route
 * handler, which puts the refresh token in an httpOnly cookie and keeps the
 * access token in memory. Nothing here writes storage.
 */
export function useLogin(
  onTokens: (tokens: TokenResponse) => Promise<void> | void,
): UseMutationResult<TokenResponse, Error, LoginRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (body: LoginRequest) => {
      const tokens = await client.call(endpoints.auth.login, { body: { kind: "web", ...body } });
      await onTokens(tokens);
      return tokens;
    },
  });
}

/**
 * Confirm an email address.
 *
 * This does **not** sign anyone in: `POST /auth/verify-email` answers
 * `{verified: true}` and nothing more, because a confirmation link arrives in a
 * mailbox and a link that both proves an address and hands out a session is a
 * session anyone with mailbox access inherits. The shell sends the user to sign
 * in afterwards.
 */
export function useVerifyEmail(): UseMutationResult<{ verified: true }, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (token: string) => client.call(endpoints.auth.verifyEmail, { body: { token } }),
  });
}

export function useConsumeMagicLink(
  onTokens: (tokens: TokenResponse) => Promise<void> | void,
): UseMutationResult<TokenResponse, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const tokens = await client.call(endpoints.auth.consumeMagicLink, {
        body: { token, kind: "web" },
      });
      await onTokens(tokens);
      return tokens;
    },
  });
}

/** Finish a Google sign-up: `status=registration` needs the age gate answered. */
export function useCompleteOAuth(
  onTokens: (tokens: TokenResponse) => Promise<void> | void,
): UseMutationResult<TokenResponse, Error, OAuthCompleteRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (body: OAuthCompleteRequest) => {
      const tokens = await client.call(endpoints.auth.completeOAuth, { body });
      await onTokens(tokens);
      return tokens;
    },
  });
}

/**
 * Switch workspace (CONTRACTS §5 — the only way; there is no header).
 *
 * The whole query cache is cleared rather than selectively invalidated: the new
 * token scopes every read, and a stale entry from the previous workspace is a
 * tenant-confusion bug waiting to be screenshotted (THREAT-MODEL T4).
 */
export function useSwitchWorkspace(
  onTokens: (tokens: TokenResponse) => Promise<void> | void,
): UseMutationResult<TokenResponse, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (workspaceId: string) => {
      const tokens = await client.call(endpoints.auth.exchangeWorkspace, { body: { workspaceId } });
      await onTokens(tokens);
      return tokens;
    },
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

/**
 * F-002 steps 1–3. The answers live in the user's free-form `onboarding` object
 * (A05); B17 turns them into defaults and attribution events.
 */
export function useSaveOnboarding(): UseMutationResult<CurrentUser, Error, OnboardingProfile> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: OnboardingProfile) =>
      client.call(endpoints.account.updateMe, {
        body: { onboarding: { ...profile, completedAt: new Date().toISOString() } },
      }),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.me(), user);
    },
  });
}

// --- Device grant (THREAT-MODEL T3) ----------------------------------------

export function useDeviceApproval(userCode: string | null): UseQueryResult<PendingApproval> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.deviceApproval(userCode ?? "none"),
    enabled: userCode !== null && userCode !== "",
    retry: false,
    // A pending code lives ten minutes at most and its facts never change, so
    // there is nothing to refetch.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => client.call(endpoints.device.describe, { params: { userCode: userCode ?? "" } }),
  });
}

export function useDecideDeviceApproval(): UseMutationResult<
  { status: "approved" | "denied" },
  Error,
  { userCode: string; decision: "approve" | "deny"; workspaceId?: string }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.device.decide, { body }),
  });
}

// --- Billing, credits, offers (B01/B02/B04) ---------------------------------

/** The workspace's current subscription, or `null` with no plan on file. */
/**
 * B06's streak state (sidebar chip, Subscription widget). `eligible:false`
 * means "render nothing" — the flag is off, the caller is a declared minor,
 * or the workspace has not been assigned; a holdout workspace also answers
 * with real state but MUST never be shown a reward (`nextRewardLabel` is
 * still computed for it, so a consumer checks `holdout` explicitly, not just
 * `eligible`, before rendering anything reward-shaped).
 */
export function useStreak(): UseQueryResult<StreakView> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.streak(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    staleTime: 60_000,
    queryFn: () => client.call(endpoints.streak.getStreak),
  });
}

export function useSubscription(): UseQueryResult<SubscriptionView | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.subscription(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.billing.getSubscription),
  });
}

/** Cached balance, next grant reset, and live lots (B02). */
export function useWorkspaceCredits(): UseQueryResult<CreditsSummary> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.credits(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.credits.getBalance, { params: { id: workspaceId ?? "" } }),
  });
}

// --- Projects, folders and media (A06, A14) ---------------------------------

/**
 * Cursor-paginated project list, for `/projects` and Home's Recent grid.
 *
 * `useInfiniteQuery` rather than `useQuery`: the brief's infinite scroll wants
 * pages appended, not a growing `limit`, and the query key already carries the
 * filters, so changing search or a filter starts a fresh cursor chain instead
 * of mixing pages from two different queries.
 */
export function useProjects(
  query: Omit<ListProjectsQuery, "cursor"> = {},
): UseInfiniteQueryResult<InfiniteData<ProjectPage>, Error> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useInfiniteQuery({
    queryKey: queryKeys.projects(workspaceId ?? "none", query),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.call(endpoints.projects.list, {
        query: { ...query, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useProject(projectId: string | null): UseQueryResult<Project> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.project(workspaceId ?? "none", projectId ?? "none"),
    enabled: workspaceId !== null && projectId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.projects.get, { params: { projectId: projectId ?? "" } }),
  });
}

function invalidateProjects(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string | null,
): void {
  void queryClient.invalidateQueries({ queryKey: ["ws", workspaceId ?? "none", "projects"] });
}

export function useCreateProject(): UseMutationResult<Project, Error, CreateProjectRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.projects.create, { body }),
    onSuccess: () => invalidateProjects(queryClient, workspaceId),
  });
}

/** "Try with a sample" (08 §Home): no request body, a real project comes back. */
export function useCreateSampleProject(): UseMutationResult<Project, Error, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: () => client.call(endpoints.projects.createSample),
    onSuccess: () => invalidateProjects(queryClient, workspaceId),
  });
}

export function useBatchCreateProjects(): UseMutationResult<
  { created: Project[] },
  Error,
  BatchCreateProjectsRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.projects.batchCreate, { body }),
    onSuccess: () => invalidateProjects(queryClient, workspaceId),
  });
}

export function useUpdateProject(): UseMutationResult<
  Project,
  Error,
  { projectId: string; body: UpdateProjectRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, body }) =>
      client.call(endpoints.projects.update, { params: { projectId }, body }),
    onSuccess: () => invalidateProjects(queryClient, workspaceId),
  });
}

/** Archive is `update({status: "archived"})`; delete is this — soft, on the server. */
export function useDeleteProject(): UseMutationResult<{ id: string }, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (projectId) => client.call(endpoints.projects.remove, { params: { projectId } }),
    onSuccess: () => invalidateProjects(queryClient, workspaceId),
  });
}

export function useFolders(): UseQueryResult<Folder[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.folders(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.folders.list),
  });
}

function invalidateFolders(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string | null,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.folders(workspaceId ?? "none") });
}

export function useCreateFolder(): UseMutationResult<Folder, Error, CreateFolderRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.folders.create, { body }),
    onSuccess: () => invalidateFolders(queryClient, workspaceId),
  });
}

export function useUpdateFolder(): UseMutationResult<
  Folder,
  Error,
  { folderId: string; body: UpdateFolderRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ folderId, body }) =>
      client.call(endpoints.folders.update, { params: { folderId }, body }),
    onSuccess: () => invalidateFolders(queryClient, workspaceId),
  });
}

export function useDeleteFolder(): UseMutationResult<{ id: string }, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (folderId) => client.call(endpoints.folders.remove, { params: { folderId } }),
    onSuccess: () => invalidateFolders(queryClient, workspaceId),
  });
}

export function useProjectMedia(projectId: string | null): UseQueryResult<Media[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.projectMedia(workspaceId ?? "none", projectId ?? "none"),
    enabled: workspaceId !== null && projectId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.media.list, { params: { projectId: projectId ?? "" } }),
  });
}

/**
 * Begin an upload. Imperative rather than a `useMutation` most of the time —
 * `apps/web/lib/upload` calls `useRawApiClient()` directly so it can drive
 * retries and pause/resume itself — but a component that only needs to kick one
 * off (replace, a single small file) can use this.
 */
export function useInitMediaUpload(): UseMutationResult<
  UploadTicket,
  Error,
  { projectId: string; body: InitUploadRequest }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: ({ projectId, body }) =>
      client.call(endpoints.media.init, { params: { projectId }, body }),
  });
}

export function useCompleteMediaUpload(): UseMutationResult<
  CompletedUpload,
  Error,
  { projectId: string; mediaId: string; body: CompleteUploadRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, mediaId, body }) =>
      client.call(endpoints.media.complete, { params: { projectId, mediaId }, body }),
    onSuccess: () => invalidateProjects(queryClient, workspaceId),
  });
}

// --- Jobs (A08, A14) ---------------------------------------------------------

/**
 * A project's jobs, newest first — the polling fallback `JobProgress` needs
 * when the realtime channel is off or has not caught up yet (08 §2).
 *
 * `refetchInterval` only runs while at least one job is still live; once every
 * job the last page returned has settled, polling stops on its own rather than
 * hammering `/jobs` for a project nothing is happening to.
 */
export function useProjectJobs(
  projectId: string | null,
  options: { pollMs?: number } = {},
): UseQueryResult<JobPage> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const pollMs = options.pollMs ?? 4_000;
  return useQuery({
    queryKey: queryKeys.projectJobs(workspaceId ?? "none", projectId ?? "none"),
    enabled: workspaceId !== null && projectId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.jobs.list, { query: { projectId: projectId ?? "" } }),
    refetchInterval: (query) => {
      const page = query.state.data;
      const stillLive = page?.items.some(
        (job) => job.status === "queued" || job.status === "running",
      );
      return stillLive === true ? pollMs : false;
    },
  });
}

export function useCancelJob(): UseMutationResult<JobSummary, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (jobId) => client.call(endpoints.jobs.cancel, { params: { id: jobId } }),
  });
}

// --- Styles (A16, A14, D64) --------------------------------------------------

/**
 * The style catalogue: system styles plus this workspace's own presets
 * (`GET /styles`). `system-styles.ts`'s bundled JSON is the caller's fallback
 * for the dev/offline case — this hook does not fall back on its own, so a
 * genuine outage still surfaces as an error a caller can act on.
 */
export function useStyles(): UseQueryResult<StyleCatalogueEntry[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.styles(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    staleTime: 60_000,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.styles.list),
  });
}

function invalidateStyles(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string | null,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.styles(workspaceId ?? "none") });
}

export function useCreateStylePreset(): UseMutationResult<
  StyleCatalogueEntry,
  Error,
  StylePresetRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.styles.createPreset, {
        params: { id: workspaceId ?? "" },
        body,
      }),
    onSuccess: () => invalidateStyles(queryClient, workspaceId),
  });
}

export function useUpdateStylePreset(): UseMutationResult<
  StyleCatalogueEntry,
  Error,
  { presetId: string; body: StylePresetRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ presetId, body }) =>
      client.call(endpoints.styles.updatePreset, {
        params: { id: workspaceId ?? "", presetId },
        body,
      }),
    onSuccess: () => invalidateStyles(queryClient, workspaceId),
  });
}

export function useDeleteStylePreset(): UseMutationResult<{ id: string }, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (presetId) =>
      client.call(endpoints.styles.deletePreset, {
        params: { id: workspaceId ?? "", presetId },
      }),
    onSuccess: () => invalidateStyles(queryClient, workspaceId),
  });
}

/**
 * Start transcription with the quick-pick options (A11). Returns `null`
 * rather than throwing when the media has not been probed yet
 * (`transcript/media_not_ready`, a 409 — the common case right after an
 * upload, before `media.probe` has finished), so a caller can invoke this
 * unconditionally and treat "not yet" as a normal outcome: the project still
 * exists and is still ready to open, it just is not transcribing itself yet.
 */
export function useTranscribe(): UseMutationResult<
  TranscribeAccepted | null,
  Error,
  { projectId: string } & TranscribeRequest
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async ({ projectId, ...body }) => {
      try {
        return await client.call(endpoints.transcripts.transcribe, {
          params: { projectId },
          body,
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === "transcript/media_not_ready") {
          return null;
        }
        throw error;
      }
    },
  });
}

// --- Scripts and translation (A22) ------------------------------------------

/**
 * `GET /projects/{id}/transcript/scripts` — which scripts this transcript has,
 * and where they came from. Drives the editor's script tabs (Roman / Native /
 * EN / +Add translation…).
 */
export function useTranscriptScripts(projectId: string | null): UseQueryResult<AvailableScripts> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.transcriptScripts(workspaceId ?? "none", projectId ?? "none"),
    enabled: workspaceId !== null && projectId !== null && projectId !== "",
    retry: retryPolicy,
    queryFn: () =>
      client.call(endpoints.transcriptScripts.scripts, {
        params: { projectId: projectId ?? "" },
      }),
  });
}

// --- Insights (B11) ----------------------------------------------------------

/**
 * `GET /projects/{id}/insights` — the most recent chapters/summary/hooks
 * result per kind, plus the ASCI-friendly disclosure line to render next to
 * whichever kind is shown.
 */
export function useProjectInsights(projectId: string | null): UseQueryResult<InsightsResponse> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.insights(workspaceId ?? "none", projectId ?? "none"),
    enabled: workspaceId !== null && projectId !== null && projectId !== "",
    retry: retryPolicy,
    queryFn: () =>
      client.call(endpoints.insights.list, {
        params: { projectId: projectId ?? "" },
      }),
  });
}

/**
 * `POST /projects/{id}/insights` — request (or regenerate) chapters, summary
 * and/or hooks. Invalidates the read on success so a poller (`job.completed`)
 * picking up the worker's completion is not required for the UI to refetch.
 */
export function useRequestInsights(
  projectId: string,
): UseMutationResult<InsightsAccepted, Error, InsightsRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.insights.request, { params: { projectId }, body }),
    onSuccess: () => {
      if (workspaceId !== null) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.insights(workspaceId, projectId),
        });
      }
    },
  });
}
/**
 * What this workspace may buy right now, and why not otherwise (B04): the
 * signup gift, the ₹9 clean export, the week pass, the ₹149 Free top-up.
 * Every amount comes from here — the export-dialog upsell panel and the
 * Subscription overview never hardcode a price.
 */
export function useOffersEligibility(): UseQueryResult<OffersEligibilityView> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.offersEligibility(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    // Short: a purchase should be reflected within a few seconds of the
    // webhook landing, not held stale behind a long cache.
    staleTime: 5_000,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.offers.eligibility),
  });
}

/** Every pass this workspace has bought, newest first (B04). */
export function useOffersPasses(): UseQueryResult<PassView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.offersPasses(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.offers.listPasses),
  });
}

/**
 * Start a pass checkout (₹9 clean export, week pass, or pay-once credits).
 * On success, invalidates the eligibility/passes reads so the upsell panel and
 * the Subscription overview refetch once the caller has driven Razorpay
 * Checkout to completion — the checkout call itself only creates the order;
 * nothing is granted until the webhook lands (THREAT-MODEL: a client can never
 * self-report a payment as done).
 */
export function usePassCheckout(): UseMutationResult<
  PassCheckoutResponse,
  Error,
  PassCheckoutRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.billing.createPassCheckout, { body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.offersEligibility(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.offersPasses(workspaceId) });
    },
  });
}

/**
 * This workspace's referral code and reward counts (B07b). Backs the
 * Invite-friends tab and the give-get sheet.
 */
export function useReferralStats(): UseQueryResult<ReferralStats> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.referrals(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.referrals.me),
  });
}

/**
 * Claim a code posted at onboarding (B07b). A non-referral code (no `AK-`
 * prefix) resolves with `claimed: false` rather than an error — B07's
 * affiliate attribution owns everything else typed into the same field.
 */
export function useClaimReferral(): UseMutationResult<
  ClaimReferralResult,
  Error,
  ClaimReferralRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.referrals.claim, { body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.referrals(workspaceId) });
    },
  });
}

/**
 * Attaches affiliate attribution for a code typed at onboarding that is not
 * `AK-`-shaped (B17). Public: it is the same route the sign-up cookie flow
 * (`/r/<code>`) resolves through, so it needs no bearer token, but the
 * workspace/user ids are still required — the onboarding caller already has
 * both from `useCurrentUser()`.
 */
export function useAttachAffiliateAttribution(): UseMutationResult<
  AttachAffiliateAttributionResult,
  Error,
  AttachAffiliateAttributionRequest
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.affiliate.attach, { body }),
  });
}

/** Marks the give-get sheet as shown for this workspace — it shows once, ever (B07b). */
export function useMarkReferralPromptShown(): UseMutationResult<
  DismissReferralPromptResult,
  Error,
  void
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: () => client.call(endpoints.referrals.markPromptShown),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.referrals(workspaceId) });
    },
  });
}

// -----------------------------------------------------------------------
// Academy (B12): track progress, one-time rewards, What's-new.
// -----------------------------------------------------------------------

/** This workspace's Academy progress — completed steps per track, and rewards granted. */
export function useAcademyProgress(): UseQueryResult<AcademyProgressResponse> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.academyProgress(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.academy.progress),
  });
}

/** Mark an Academy step done ("Mark done"). Idempotent; may grant the track's reward. */
export function useMarkAcademyStepDone(): UseMutationResult<
  MarkStepDoneResult,
  Error,
  { trackId: string; stepId: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ trackId, stepId }) =>
      client.call(endpoints.academy.markStepDone, { params: { trackId, stepId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.academyProgress(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.credits(workspaceId) });
    },
  });
}

/** The last changelog version this user has dismissed the What's-new modal for. */
export function useDismissedChangelogVersion(): UseQueryResult<ChangelogDismissedResponse> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.changelogDismissed(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.academy.getDismissedChangelog),
  });
}

/** Marks the What's-new modal seen for a changelog version. */
export function useDismissChangelogVersion(): UseMutationResult<
  ChangelogDismissedResponse,
  Error,
  string
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (version) => client.call(endpoints.academy.dismissChangelog, { body: { version } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.changelogDismissed(workspaceId) });
    },
  });
}

// -----------------------------------------------------------------------
// Support tickets (B12).
// -----------------------------------------------------------------------

/** This workspace's support tickets, newest first. */
export function useSupportTickets(): UseQueryResult<ListSupportTicketsResponse> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.supportTickets(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.support.list),
  });
}

/** File a support ticket, optionally with a consent-gated diagnostics bundle. */
export function useCreateSupportTicket(): UseMutationResult<
  SupportTicketView,
  Error,
  CreateSupportTicketRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.support.create, { body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.supportTickets(workspaceId) });
    },
  });
}

/**
 * Attach a diagnostics bundle (a zip built elsewhere, e.g. by the desktop
 * app) to a ticket the caller already filed (C12): presign, `PUT` the bytes
 * straight to R2, then confirm. Requires the `telemetry` consent — the API
 * rejects the presign step with `telemetry/consent_required` otherwise.
 */
export function useAttachDiagnosticsBundle(): UseMutationResult<
  ConfirmDiagnosticsBundleResponse,
  Error,
  { ticketId: string; file: Blob }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async ({ ticketId, file }) => {
      const presigned = await client.call(endpoints.telemetry.presignDiagnosticsBundle, {
        body: { ticketId },
      });
      const response = await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/zip" },
        body: file,
      });
      if (!response.ok) {
        throw new Error(`Uploading the diagnostics bundle failed (${String(response.status)}).`);
      }
      return client.call(endpoints.telemetry.confirmDiagnosticsBundle, { body: { ticketId } });
    },
  });
}

/** Start a top-up checkout (₹149/100 credits on Free, or a larger pack on a paid plan). */
export function useTopupCheckout(): UseMutationResult<
  PassCheckoutResponse,
  Error,
  TopupCheckoutRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) => client.call(endpoints.billing.createTopupCheckout, { body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.credits(workspaceId) });
    },
  });
}

/**
 * `POST /projects/{id}/transcript/transliterate` — free. On success, refetches
 * the scripts list so a new tab appears without a manual reload.
 */
export function useTransliterateTranscript(
  projectId: string,
): UseMutationResult<TransliterateAccepted, Error, TransliterateRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.transcriptScripts.transliterate, { params: { projectId }, body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.transcriptScripts(workspaceId, projectId),
      });
    },
  });
}

/**
 * `POST /projects/{id}/transcript/translate` — 0.5 credit / media minute /
 * target (English on Starter+, every language on Creator+; a refused plan
 * comes back as `transcript/plan_required`, CONTRACTS §8).
 */
export function useTranslateTranscript(
  projectId: string,
): UseMutationResult<TranslateAccepted, Error, TranslateRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.transcriptScripts.translate, { params: { projectId }, body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.transcriptScripts(workspaceId, projectId),
      });
    },
  });
}

// --- Affiliate (B07) -----------------------------------------------------------

export function useMyAffiliate(): UseQueryResult<AffiliateProfile | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.affiliate(),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    // The route wraps `{ affiliate }` rather than a bare nullable body — a
    // handler returning `null`/`undefined` makes Nest's Express adapter send
    // an empty body (`isNil(body)` → `response.send()`), which `readJson`
    // then reads back as `undefined`, and TanStack Query refuses `undefined`
    // as query data outright.
    queryFn: async () => (await client.call(endpoints.affiliate.me)).affiliate,
  });
}

export function useMyAffiliateStats(enabled: boolean): UseQueryResult<AffiliateStats> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.affiliateStats(),
    enabled,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.affiliate.stats),
  });
}

export function useApplyAffiliate(): UseMutationResult<
  AffiliateProfile,
  Error,
  ApplyAffiliateRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApplyAffiliateRequest) => client.call(endpoints.affiliate.apply, { body }),
    onSuccess: (affiliate) => {
      queryClient.setQueryData(queryKeys.affiliate(), affiliate);
    },
  });
}

/** Escape hatch for a call the hooks do not cover yet (A14 and later). */
export function useRawApiClient(): ApiClient {
  return useApiContext().client;
}

// --- Team: members, roles, ownership transfer (A05, B08) -------------------

export function useMembers(): UseQueryResult<MemberView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.members(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () =>
      client.call(endpoints.account.listMembers, { params: { id: workspaceId ?? "" } }),
  });
}

export function useInviteMember(): UseMutationResult<MemberView, Error, InviteMemberRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.account.inviteMember, { params: { id: workspaceId ?? "" }, body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
    },
  });
}

export function useChangeMemberRole(): UseMutationResult<
  MemberView,
  Error,
  { membershipId: string; role: ChangeRoleRequest["role"] }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ membershipId, role }) =>
      client.call(endpoints.account.changeMemberRole, {
        params: { id: workspaceId ?? "", membershipId },
        body: { role },
      }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
    },
  });
}

export function useRemoveMember(): UseMutationResult<
  { id: string; status: MembershipStatus },
  Error,
  string
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (membershipId) =>
      client.call(endpoints.account.removeMember, {
        params: { id: workspaceId ?? "", membershipId },
      }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
    },
  });
}

/**
 * Owner only. The first call (no `confirmToken`) sends a confirmation to the
 * current owner; the second, with that token, executes the transfer
 * (orchestrator addendum after A05).
 */
export function useTransferOwnership(): UseMutationResult<
  TransferOwnershipResult,
  Error,
  TransferOwnershipRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.account.transferOwnership, { params: { id: workspaceId ?? "" }, body }),
    onSuccess: (result) => {
      if (result.status !== "transferred" || workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
    },
  });
}

// --- Devices (B08) -----------------------------------------------------------

export function useDevices(): UseQueryResult<DeviceView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.devices(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.registeredDevices.list),
  });
}

export function useRenameDevice(): UseMutationResult<
  DeviceView,
  Error,
  { deviceId: string; name: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ deviceId, name }) =>
      client.call(endpoints.registeredDevices.rename, { params: { deviceId }, body: { name } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices(workspaceId) });
    },
  });
}

export function useRevokeDevice(): UseMutationResult<DeviceView, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (deviceId) =>
      client.call(endpoints.registeredDevices.revoke, { params: { deviceId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices(workspaceId) });
    },
  });
}

// --- Licence keys (B08) -------------------------------------------------------

export function useLicenseKeys(): UseQueryResult<LicenseKeyView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.licenseKeys(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.licensing.list, { params: { id: workspaceId ?? "" } }),
  });
}

export function useCreateLicenseKey(): UseMutationResult<
  LicenseKeyView,
  Error,
  CreateLicenseKeyRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.licensing.create, { params: { id: workspaceId ?? "" }, body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.licenseKeys(workspaceId) });
    },
  });
}

export function useRevokeLicenseKey(): UseMutationResult<LicenseKeyView, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (keyId) =>
      client.call(endpoints.licensing.revoke, { params: { id: workspaceId ?? "", keyId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.licenseKeys(workspaceId) });
    },
  });
}

// --- Plugins channel manifest (C11) ------------------------------------------

/** No workspace to key on — public, same manifest for every caller. */
export function usePluginManifest(): UseQueryResult<PluginManifestResponse> {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.pluginManifest(),
    staleTime: 300_000,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.plugins.manifest),
  });
}

// --- Client tags (B08, Agency) -----------------------------------------------

export function useClientTags(): UseQueryResult<ClientTagView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.clientTags(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.clientTags.list, { params: { id: workspaceId ?? "" } }),
  });
}

export function useSetProjectClientTag(): UseMutationResult<
  { id: string; clientTag: string | null },
  Error,
  { projectId: string; clientTag: string | null }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, clientTag }) =>
      client.call(endpoints.clientTags.setProjectTag, {
        params: { id: workspaceId ?? "", projectId },
        body: { clientTag },
      }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.clientTags(workspaceId) });
    },
  });
}

// --- B14: API keys and webhooks (Settings → Developers) --------------------

export function useApiKeys(): UseQueryResult<ApiKeyView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.apiKeys(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.apiKeys.list, { params: { id: workspaceId ?? "" } }),
  });
}

export function useCreateApiKey(): UseMutationResult<MintedApiKeyView, Error, CreateApiKeyRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.apiKeys.create, { params: { id: workspaceId ?? "" }, body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(workspaceId) });
    },
  });
}

export function useRotateApiKey(): UseMutationResult<MintedApiKeyView, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (keyId) =>
      client.call(endpoints.apiKeys.rotate, { params: { id: workspaceId ?? "", keyId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(workspaceId) });
    },
  });
}

export function useRevokeApiKey(): UseMutationResult<ApiKeyView, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (keyId) =>
      client.call(endpoints.apiKeys.revoke, { params: { id: workspaceId ?? "", keyId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(workspaceId) });
    },
  });
}

export function useWebhookEndpoints(): UseQueryResult<WebhookEndpointView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.webhooks(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(endpoints.webhooks.list, { params: { id: workspaceId ?? "" } }),
  });
}

export function useCreateWebhookEndpoint(): UseMutationResult<
  CreatedWebhookEndpointView,
  Error,
  CreateWebhookRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(endpoints.webhooks.create, { params: { id: workspaceId ?? "" }, body }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks(workspaceId) });
    },
  });
}

export function useUpdateWebhookEndpoint(): UseMutationResult<
  WebhookEndpointView,
  Error,
  { endpointId: string; body: UpdateWebhookRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ endpointId, body }) =>
      client.call(endpoints.webhooks.update, {
        params: { id: workspaceId ?? "", endpointId },
        body,
      }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks(workspaceId) });
    },
  });
}

export function useDeleteWebhookEndpoint(): UseMutationResult<{ id: string }, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (endpointId) =>
      client.call(endpoints.webhooks.remove, { params: { id: workspaceId ?? "", endpointId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks(workspaceId) });
    },
  });
}

export function useSendWebhookTestEvent(): UseMutationResult<
  { deliveryId: string },
  Error,
  string
> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (endpointId) =>
      client.call(endpoints.webhooks.test, { params: { id: workspaceId ?? "", endpointId } }),
  });
}

export function useWebhookDeliveries(
  endpointId: string | null,
): UseQueryResult<WebhookDeliveryView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: queryKeys.webhookDeliveries(workspaceId ?? "none", endpointId ?? "none"),
    enabled: workspaceId !== null && endpointId !== null,
    retry: retryPolicy,
    queryFn: () =>
      client.call(endpoints.webhooks.deliveries, {
        params: { id: workspaceId ?? "", endpointId: endpointId ?? "" },
      }),
  });
}

export function useRedeliverWebhookDelivery(): UseMutationResult<{ id: string }, Error, string> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (deliveryId) =>
      client.call(endpoints.webhooks.redeliver, {
        params: { id: workspaceId ?? "", deliveryId },
      }),
  });
}
