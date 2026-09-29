/**
 * Dubbing (2026-10-04): a clip in other languages, in the speaker's own voice,
 * with captions in the new language. The routes are described here, ahead of
 * the regenerated OpenAPI index, like the compilations routes
 * (`repurpose-compilations.ts`).
 *
 * `GET /repurpose/runs/{runId}/dubs`,
 * `POST /repurpose/runs/{runId}/clips/{clipId}/dubs`,
 * `POST /repurpose/runs/{runId}/dubs/{dubId}/retry` and `.../cancel`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient, useWorkspaceId } from "./context.js";
import { isApiError } from "./errors.js";
import { defineEndpoint } from "./http.js";
import { queryKeys } from "./query-keys.js";

/** The dubbing vendor's languages, as its API spells them. */
export type RepurposeDubLanguageCode =
  | "en-IN"
  | "hi-IN"
  | "bn-IN"
  | "gu-IN"
  | "kn-IN"
  | "ml-IN"
  | "mr-IN"
  | "or-IN"
  | "pa-IN"
  | "ta-IN"
  | "te-IN"
  | "as-IN";

export interface RepurposeDubLanguage {
  code: RepurposeDubLanguageCode;
  name: string;
}

/** A dubbed shape's captioned video. */
export interface RepurposeDubCaptioned {
  status: "rendering" | "ready" | "stale" | "failed";
  playUrl: string | null;
  downloadUrl: string | null;
}

/** One shape of one language: its captioned video, its clean copy, its project to edit. */
export interface RepurposeDubFormat {
  shape: "9:16" | "4:5" | "1:1" | "16:9";
  status: "preparing" | "rendering" | "ready" | "stale" | "failed";
  projectId: string | null;
  captioned: RepurposeDubCaptioned | null;
  cleanUrl: string | null;
}

export interface RepurposeDubLanguageView extends RepurposeDubLanguage {
  status: "queued" | "dubbing" | "making" | "ready" | "failed" | "cancelled";
  /** Why this language failed, in words. */
  reason: string | null;
  formats: RepurposeDubFormat[];
}

/**
 * One dub of a clip. `progress` and `step` are the vendor's own percent and
 * step label while it dubs.
 */
export interface RepurposeDub {
  id: string;
  runId: string;
  clipId: string;
  status: "waiting" | "dubbing" | "making" | "ready" | "failed" | "cancelled";
  failureCode: string | null;
  failureMessage: string | null;
  sourceLanguage: RepurposeDubLanguage;
  languages: RepurposeDubLanguageView[];
  durationMs: number;
  costTenths: number;
  progress: number | null;
  step: string | null;
  canRetry: boolean;
  canCancel: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a clip offers the "Dub into…" dialog. */
export interface RepurposeDubOffer {
  clipId: string;
  ready: boolean;
  /** Null when the vendor cannot dub from the clip's language. */
  sourceLanguage: RepurposeDubLanguage | null;
  durationMs: number | null;
  /** Languages already dubbed, or being dubbed. */
  taken: RepurposeDubLanguageCode[];
}

export interface RepurposeDubList {
  runId: string;
  /** Dubbing is switched on for this workspace. */
  enabled: boolean;
  /** Credits (tenths) per minute of clip per language. */
  tenthsPerMinute: number;
  languages: RepurposeDubLanguage[];
  clips: RepurposeDubOffer[];
  dubs: RepurposeDub[];
}

export interface CreateRepurposeDubRequest {
  languages: RepurposeDubLanguageCode[];
  /** "I have the right to use this speaker's voice, and consent to it being cloned." */
  consent: boolean;
}

const dubsEndpoint = defineEndpoint<void, RepurposeDubList>({
  method: "GET",
  path: "/repurpose/runs/{runId}/dubs",
  auth: "bearer",
});

const createDubEndpoint = defineEndpoint<CreateRepurposeDubRequest, RepurposeDub>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/dubs",
  auth: "bearer",
});

const retryDubEndpoint = defineEndpoint<void, RepurposeDub>({
  method: "POST",
  path: "/repurpose/runs/{runId}/dubs/{dubId}/retry",
  auth: "bearer",
});

const cancelDubEndpoint = defineEndpoint<void, RepurposeDub>({
  method: "POST",
  path: "/repurpose/runs/{runId}/dubs/{dubId}/cancel",
  auth: "bearer",
});

/** Under the run's own key, so a run's realtime invalidation refreshes them too. */
export function dubsQueryKey(workspaceId: string, runId: string) {
  return [...queryKeys.repurposeRun(workspaceId, runId), "dubs"] as const;
}

/** Every 5 s while a dub is being made (the vendor's percent moves). */
export const DUBS_POLL_MS = 5_000;
/** A settled list with files is read again well inside the hour its URLs are signed for. */
export const DUBS_URL_REFRESH_MS = 10 * 60_000;

export function dubsPollDelay(list: RepurposeDubList | undefined): number | false {
  const dubs = list?.dubs ?? [];
  if (
    dubs.some(
      (dub) => dub.status === "waiting" || dub.status === "dubbing" || dub.status === "making",
    )
  ) {
    return DUBS_POLL_MS;
  }
  const hasFiles = dubs.some((dub) =>
    dub.languages.some((language) =>
      language.formats.some(
        (format) => format.captioned?.playUrl != null || format.cleanUrl !== null,
      ),
    ),
  );
  return hasFiles ? DUBS_URL_REFRESH_MS : false;
}

/**
 * What a dub of `languages` languages of a clip this long costs, in tenths:
 * the clip's length rounded up to the second, at the list's rate. The same sum
 * the API holds (`dub-pricing.ts`), so the dialog's line is the charge.
 */
export function dubCostTenths(
  durationMs: number,
  languages: number,
  tenthsPerMinute: number,
): number {
  const seconds =
    !Number.isFinite(durationMs) || durationMs <= 0 ? 1 : Math.ceil(durationMs / 1000);
  const count = Math.max(0, Math.floor(languages));
  return Math.ceil((Math.max(1, seconds) * count * tenthsPerMinute) / 60);
}

const noRetryOn4xx = (failureCount: number, error: Error): boolean =>
  !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2;

/** A run's dubs and what each clip can be dubbed into, polled while one is being made. */
export function useRepurposeDubs(
  runId: string | null,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<RepurposeDubList> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: dubsQueryKey(workspaceId ?? "none", runId ?? "none"),
    enabled: workspaceId !== null && runId !== null && options.enabled !== false,
    retry: noRetryOn4xx,
    refetchInterval: (query) => dubsPollDelay(query.state.data),
    refetchOnWindowFocus: true,
    queryFn: () => client.call(dubsEndpoint, { params: { runId: runId ?? "" } }),
  });
}

/** Whether an answer is a dub, before the page's list is trusted with it. */
export function isRepurposeDub(value: unknown): value is RepurposeDub {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RepurposeDub>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.clipId === "string" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.languages)
  );
}

/** Puts one dub into the cached list, replacing its older copy. */
export function cacheDub(
  queryClient: Pick<QueryClient, "setQueryData">,
  workspaceId: string,
  dub: RepurposeDub,
): void {
  queryClient.setQueryData<RepurposeDubList>(dubsQueryKey(workspaceId, dub.runId), (current) =>
    current === undefined
      ? current
      : {
          ...current,
          dubs: [...current.dubs.filter((entry) => entry.id !== dub.id), dub],
        },
  );
}

function useDubMutation<TInput extends { readonly runId: string }>(
  call: (input: TInput) => Promise<RepurposeDub>,
): UseMutationResult<RepurposeDub, Error, TInput> {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: call,
    onSuccess: (dub, input) => {
      if (workspaceId === null) return;
      // Shown at once, then read back: the list is the server's word for it.
      if (isRepurposeDub(dub)) cacheDub(queryClient, workspaceId, dub);
      void queryClient.invalidateQueries({ queryKey: dubsQueryKey(workspaceId, input.runId) });
    },
  });
}

/**
 * Dub a clip. Resolves with the dub (the one already asked for, when the same
 * languages were). Rejects with the dub's own refusals: `dub/consent_required`,
 * `dub/language_taken` (`details.languages`), `dub/no_credits`,
 * `dub/budget_reached`, ...
 */
export function useCreateRepurposeDub(): UseMutationResult<
  RepurposeDub,
  Error,
  { readonly runId: string; readonly clipId: string; readonly body: CreateRepurposeDubRequest }
> {
  const client = useApiClient();
  return useDubMutation((input) =>
    client.call(createDubEndpoint, {
      params: { runId: input.runId, clipId: input.clipId },
      body: input.body,
    }),
  );
}

/** Dub again after a failure; a vendor job that did not itself fail is resumed. */
export function useRetryRepurposeDub(): UseMutationResult<
  RepurposeDub,
  Error,
  { readonly runId: string; readonly dubId: string }
> {
  const client = useApiClient();
  return useDubMutation((input) =>
    client.call(retryDubEndpoint, { params: { runId: input.runId, dubId: input.dubId } }),
  );
}

/** Stop a dub that is waiting or with the vendor; its credits come back. */
export function useCancelRepurposeDub(): UseMutationResult<
  RepurposeDub,
  Error,
  { readonly runId: string; readonly dubId: string }
> {
  const client = useApiClient();
  return useDubMutation((input) =>
    client.call(cancelDubEndpoint, { params: { runId: input.runId, dubId: input.dubId } }),
  );
}
