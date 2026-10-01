/**
 * A run's voice-over hooks (2026-10-01, OpusClip parity wave 4): a short spoken
 * line at the start of a clip - its hook read by a stock voice in the clip's
 * language - with the clip's own sound turned down under it.
 *
 * `GET /repurpose/runs/{runId}/voiceovers` says whether the feature is on for
 * the workspace (`enabled`, the `repurpose_voiceover` flag), what each clip
 * would say, and every voice-over with a link to listen once made. Writes:
 * add (`POST .../clips/{clipId}/voiceovers`), try again and take off.
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

/** The speech vendor's languages, as its API spells them (Odia is `od-IN`). */
export type RepurposeVoiceoverLanguageCode =
  | "en-IN"
  | "hi-IN"
  | "bn-IN"
  | "gu-IN"
  | "kn-IN"
  | "ml-IN"
  | "mr-IN"
  | "od-IN"
  | "pa-IN"
  | "ta-IN"
  | "te-IN";

/** The stock voices. */
export type RepurposeVoiceoverSpeakerId =
  "anushka" | "manisha" | "vidya" | "arya" | "abhilash" | "karun" | "hitesh";

export interface RepurposeVoiceoverLanguage {
  code: RepurposeVoiceoverLanguageCode;
  name: string;
}

export interface RepurposeVoiceoverSpeaker {
  id: RepurposeVoiceoverSpeakerId;
  name: string;
}

export interface RepurposeVoiceover {
  id: string;
  runId: string;
  clipId: string;
  status: "waiting" | "speaking" | "ready" | "failed" | "removed";
  failureCode: string | null;
  failureMessage: string | null;
  text: string;
  language: RepurposeVoiceoverLanguage;
  speaker: RepurposeVoiceoverSpeaker;
  durationMs: number | null;
  costTenths: number;
  audioUrl: string | null;
  /** How many of the clip's shapes carry it now. */
  placedShapes: number;
  canRetry: boolean;
  canRemove: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a clip offers the "Add a voice-over hook" dialog. */
export interface RepurposeVoiceoverOffer {
  clipId: string;
  ready: boolean;
  /** The clip's hook line: what is said unless the person changes it. */
  text: string;
  /** Null when the voice does not speak the clip's language. */
  language: RepurposeVoiceoverLanguage | null;
  /** The voice-over the clip has (being made or made), if any. */
  voiceoverId: string | null;
  /** Finished videos of this clip that adding the voice makes again (2026-10-01). */
  rerenderVideos?: number;
  /** What making them again costs, at the cloud render rate. */
  rerenderTenths?: number;
}

export interface RepurposeVoiceoverList {
  runId: string;
  /** Voice-overs are switched on for this workspace. */
  enabled: boolean;
  /** Credits (tenths) one voice-over costs. */
  tenthsPerVoiceover: number;
  /** The cloud render rate, for a clip the list has no number for. */
  renderTenthsPerMinute?: number;
  maxTextChars: number;
  speakers: RepurposeVoiceoverSpeaker[];
  clips: RepurposeVoiceoverOffer[];
  voiceovers: RepurposeVoiceover[];
}

export interface CreateRepurposeVoiceoverRequest {
  /** The words; the clip's hook when left out. */
  text?: string;
  speaker?: RepurposeVoiceoverSpeakerId;
}

const listEndpoint = defineEndpoint<void, RepurposeVoiceoverList>({
  method: "GET",
  path: "/repurpose/runs/{runId}/voiceovers",
  auth: "bearer",
});

const createEndpoint = defineEndpoint<CreateRepurposeVoiceoverRequest, RepurposeVoiceover>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/voiceovers",
  auth: "bearer",
});

const retryEndpoint = defineEndpoint<void, RepurposeVoiceover>({
  method: "POST",
  path: "/repurpose/runs/{runId}/voiceovers/{voiceoverId}/retry",
  auth: "bearer",
});

const removeEndpoint = defineEndpoint<void, RepurposeVoiceover>({
  method: "POST",
  path: "/repurpose/runs/{runId}/voiceovers/{voiceoverId}/remove",
  auth: "bearer",
});

/** Under the run's own key, so a run's realtime invalidation refreshes them too. */
export function voiceoversQueryKey(workspaceId: string, runId: string) {
  return [...queryKeys.repurposeRun(workspaceId, runId), "voiceovers"] as const;
}

/** Every 3 s while one is being made (it takes seconds). */
export const VOICEOVERS_POLL_MS = 3_000;
/** A list with a link to listen is read again well inside the hour it is signed for. */
export const VOICEOVERS_URL_REFRESH_MS = 10 * 60_000;

export function voiceoversPollDelay(list: RepurposeVoiceoverList | undefined): number | false {
  const rows = list?.voiceovers ?? [];
  if (rows.some((row) => row.status === "waiting" || row.status === "speaking")) {
    return VOICEOVERS_POLL_MS;
  }
  return rows.some((row) => row.audioUrl !== null) ? VOICEOVERS_URL_REFRESH_MS : false;
}

const noRetryOn4xx = (failureCount: number, error: Error): boolean =>
  !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2;

/** A run's voice-overs and what each clip would say, polled while one is being made. */
export function useRepurposeVoiceovers(
  runId: string | null,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<RepurposeVoiceoverList> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: voiceoversQueryKey(workspaceId ?? "none", runId ?? "none"),
    enabled: workspaceId !== null && runId !== null && options.enabled !== false,
    retry: noRetryOn4xx,
    refetchInterval: (query) => voiceoversPollDelay(query.state.data),
    refetchOnWindowFocus: true,
    queryFn: () => client.call(listEndpoint, { params: { runId: runId ?? "" } }),
  });
}

/** Whether an answer is a voice-over, before the page's list is trusted with it. */
export function isRepurposeVoiceover(value: unknown): value is RepurposeVoiceover {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RepurposeVoiceover>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.clipId === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.text === "string"
  );
}

/** Puts one voice-over into the cached list, replacing its older copy. */
export function cacheVoiceover(
  queryClient: Pick<QueryClient, "setQueryData">,
  workspaceId: string,
  voiceover: RepurposeVoiceover,
): void {
  queryClient.setQueryData<RepurposeVoiceoverList>(
    voiceoversQueryKey(workspaceId, voiceover.runId),
    (current) =>
      current === undefined
        ? current
        : {
            ...current,
            voiceovers: [
              ...current.voiceovers.filter((entry) => entry.id !== voiceover.id),
              ...(voiceover.status === "removed" ? [] : [voiceover]),
            ],
          },
  );
}

function useVoiceoverMutation<TInput extends { readonly runId: string }>(
  call: (input: TInput) => Promise<RepurposeVoiceover>,
): UseMutationResult<RepurposeVoiceover, Error, TInput> {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: call,
    onSuccess: (voiceover, input) => {
      if (workspaceId === null) return;
      if (isRepurposeVoiceover(voiceover)) cacheVoiceover(queryClient, workspaceId, voiceover);
      void queryClient.invalidateQueries({
        queryKey: voiceoversQueryKey(workspaceId, input.runId),
      });
    },
  });
}

/**
 * Add a voice-over hook to a clip. Rejects with its own refusals:
 * `voiceover/not_enabled`, `voiceover/no_text`, `voiceover/already_has`,
 * `voiceover/no_credits`, `voiceover/budget_reached`, ...
 */
export function useCreateRepurposeVoiceover(): UseMutationResult<
  RepurposeVoiceover,
  Error,
  {
    readonly runId: string;
    readonly clipId: string;
    readonly body: CreateRepurposeVoiceoverRequest;
  }
> {
  const client = useApiClient();
  return useVoiceoverMutation((input) =>
    client.call(createEndpoint, {
      params: { runId: input.runId, clipId: input.clipId },
      body: input.body,
    }),
  );
}

/** Make a voice-over again after a failure. */
export function useRetryRepurposeVoiceover(): UseMutationResult<
  RepurposeVoiceover,
  Error,
  { readonly runId: string; readonly voiceoverId: string }
> {
  const client = useApiClient();
  return useVoiceoverMutation((input) =>
    client.call(retryEndpoint, {
      params: { runId: input.runId, voiceoverId: input.voiceoverId },
    }),
  );
}

/** Take a voice-over off its clip (or stop one being made). */
export function useRemoveRepurposeVoiceover(): UseMutationResult<
  RepurposeVoiceover,
  Error,
  { readonly runId: string; readonly voiceoverId: string }
> {
  const client = useApiClient();
  return useVoiceoverMutation((input) =>
    client.call(removeEndpoint, {
      params: { runId: input.runId, voiceoverId: input.voiceoverId },
    }),
  );
}
