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
  AffiliateProfile,
  AffiliateStats,
  ApplyAffiliateRequest,
  AvailableScripts,
  BatchCreateProjectsRequest,
  ClaimReferralRequest,
  ClaimReferralResult,
  CompleteUploadRequest,
  CompletedUpload,
  ConsentPurpose,
  ConsentState,
  CreateFolderRequest,
  CreateProjectRequest,
  CreditsSummary,
  CurrentUser,
  DismissReferralPromptResult,
  Entitlement,
  Folder,
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
  ReferralStats,
  RightsRequest,
  SessionSummary,
  SignUpRequest,
  SignUpResponse,
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
    queryFn: () => withPendingFallback(() => client.call(endpoints.pending.listMemory), []),
  });
}

export function useClearMemory(): UseMutationResult<void, Error, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      withPendingFallback(() => client.call(endpoints.pending.clearMemory), undefined),
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
