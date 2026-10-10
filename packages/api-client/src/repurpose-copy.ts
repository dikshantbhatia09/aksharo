/**
 * The words a clips run writes (2026-09-29): each moment's copy (title,
 * on-screen hook, description, hashtags, text per platform) with the language
 * model's judgement of the moment, and the episode text for the whole video.
 *
 * The copy and judgement arrive on the candidate and clip rows the run page
 * already reads (`RepurposeCandidateItem.copy`, `RepurposeClipItem.copy`) as
 * JSON columns, so an empty `{}` is "none": read them through
 * {@link clipCopyOf} and {@link judgementOf}, never by casting. The episode
 * pack's route is described here, ahead of the regenerated OpenAPI index,
 * like the other clips routes in `hooks.ts`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient, useWorkspaceId } from "./context.js";
import { isApiError } from "./errors.js";
import { defineEndpoint } from "./http.js";
import { queryKeys } from "./query-keys.js";
import type {
  DiagnosticCategory,
  DiagnosticItem,
  DiagnosticSentiment,
  ViralityDiagnostic,
} from "./types.js";

/** Who wrote the copy: the language model, the rule-based fallback, or a person. */
export type RepurposeCopySource = "model" | "heuristic" | "person";

export interface PlatformSocialPack {
  youtube: { title: string; description: string; tags: string[] };
  instagram: { caption: string; callToAction: string; hashtags: string[] };
  tiktok: { caption: string; hashtags: string[] };
  linkedin: { postText: string; hashtags: string[] };
  twitter: { tweetText: string };
}

/** `ClipCopySchema` (`@montaj/repurpose-contracts`), as the page reads it. */
export interface RepurposeClipCopy {
  summary: string;
  /** The on-screen hook for the first seconds: seven words at most. */
  hook: string;
  cta: string;
  hashtags: string[];
  /** The language it is written in, e.g. `hi-Latn` for Hinglish. */
  locale: string;
  title?: string;
  description?: string;
  platforms?: {
    youtube?: { title: string; description: string };
    instagram?: { caption: string };
    tiktok?: { caption: string };
    linkedin?: { text: string };
    x?: { text: string };
    facebook?: { text: string };
  };
  socialPack?: PlatformSocialPack;
  source?: RepurposeCopySource;
}

/** The language model's reading of a moment, 0-10 each. */
export interface RepurposeJudgement {
  standalone: number;
  payoff: number;
  humour: number;
  topicFit?: number;
  /** How hard the first seconds grab, 0-10 (2026-10-01; absent on older moments). */
  hook?: number;
  /** How much the subject is one people are talking about now, 0-10 (2026-10-01). */
  trend?: number;
  /** One sentence each on hook, flow (`standalone`), value (`payoff`) and trend. */
  notes?: { hook?: string; flow?: string; value?: string; trend?: string };
  /** People the moment names or features ("Relevant people"). */
  people?: string[];
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A clip's or candidate's copy, or null for none (`{}`, or a row from before copy). */
export function clipCopyOf(value: unknown): RepurposeClipCopy | null {
  if (!isRecord(value)) return null;
  const { summary, hook, cta, hashtags, locale } = value;
  if (
    typeof summary !== "string" ||
    typeof hook !== "string" ||
    typeof cta !== "string" ||
    !isStringArray(hashtags) ||
    typeof locale !== "string"
  ) {
    return null;
  }
  return value as unknown as RepurposeClipCopy;
}

/** A candidate's judgement, or null when no model judged it. */
export function judgementOf(value: unknown): RepurposeJudgement | null {
  if (!isRecord(value)) return null;
  const { standalone, payoff, humour, model } = value;
  return typeof standalone === "number" &&
    typeof payoff === "number" &&
    typeof humour === "number" &&
    typeof model === "string"
    ? (value as unknown as RepurposeJudgement)
    : null;
}

/** A candidate's scoring diagnostic rationale (Pillar 2 §02), or null when none. */
export function diagnosticOf(value: unknown): ViralityDiagnostic | null {
  if (!isRecord(value)) return null;
  const { overallSummary, items } = value;
  if (typeof overallSummary !== "string" || !Array.isArray(items)) {
    return null;
  }
  const validItems: DiagnosticItem[] = [];
  const validCategories = new Set<string>(["HOOK", "FLOW", "EMOTION", "TREND", "RETENTION"]);
  const validSentiments = new Set<string>(["POSITIVE", "NEUTRAL", "WARNING"]);
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { category, label, detail, sentiment } = item;
    if (
      typeof category === "string" &&
      validCategories.has(category.toUpperCase()) &&
      typeof label === "string" &&
      label.trim() !== "" &&
      typeof detail === "string" &&
      detail.trim() !== "" &&
      typeof sentiment === "string" &&
      validSentiments.has(sentiment.toUpperCase())
    ) {
      validItems.push({
        category: category.toUpperCase() as DiagnosticCategory,
        label: label.trim(),
        detail: detail.trim(),
        sentiment: sentiment.toUpperCase() as DiagnosticSentiment,
      });
    }
  }
  if (validItems.length === 0) return null;
  const creatorTip =
    typeof value["creatorTip"] === "string" && value["creatorTip"].trim() !== ""
      ? value["creatorTip"].trim()
      : undefined;
  return {
    overallSummary: overallSummary.trim(),
    items: validItems,
    ...(creatorTip ? { creatorTip } : {}),
  };
}

// ---------------------------------------------------------------------------
// The episode text pack
// ---------------------------------------------------------------------------

export interface RepurposeEpisodeChapter {
  /** On the processed file's clock: a run over part of a video starts at 0. */
  startMs: number;
  title: string;
}

export interface RepurposeEpisodePack {
  chapters: RepurposeEpisodeChapter[];
  /** Without the chapters: the page adds them, on the video's own clock. */
  youtubeDescription: string;
  showNotes: string;
  linkedinPost: string;
  xThread: string[];
  newsletter: string;
  locale: string;
  source: "model" | "heuristic" | "mixed";
}

export type RepurposeEpisodePackStatus = "none" | "writing" | "ready" | "failed";

/** `GET /repurpose/runs/{runId}/episode-pack`. */
export interface RepurposeEpisodePackView {
  runId: string;
  status: RepurposeEpisodePackStatus;
  pack: RepurposeEpisodePack | null;
  createdAt: string | null;
  /** Show it with the text: "Generated by AI from your transcript". */
  disclosure: string;
}

const episodePackEndpoint = defineEndpoint<void, RepurposeEpisodePackView>({
  method: "GET",
  path: "/repurpose/runs/{runId}/episode-pack",
  auth: "bearer",
});

const writeEpisodePackEndpoint = defineEndpoint<void, RepurposeEpisodePackView>({
  method: "POST",
  path: "/repurpose/runs/{runId}/episode-pack",
  auth: "bearer",
});

/** Under the run's own key, so a run's realtime invalidation refreshes it too. */
export function episodePackQueryKey(workspaceId: string, runId: string) {
  return [...queryKeys.repurposeRun(workspaceId, runId), "episode-pack"] as const;
}

/** While being written, every 5 s; while expected soon, every 15 s; else not at all. */
export const EPISODE_PACK_WRITING_POLL_MS = 5_000;
export const EPISODE_PACK_EXPECTED_POLL_MS = 15_000;

export function episodePackPollDelay(
  view: RepurposeEpisodePackView | undefined,
  expectSoon: boolean,
): number | false {
  if (view?.status === "writing") return EPISODE_PACK_WRITING_POLL_MS;
  if (expectSoon && (view === undefined || view.status === "none")) {
    return EPISODE_PACK_EXPECTED_POLL_MS;
  }
  return false;
}

/**
 * A run's episode text, polled while it is being written and, with
 * `expectSoon` (an Autopilot run still finding its moments), until it starts.
 */
export function useRepurposeEpisodePack(
  runId: string | null,
  options: { readonly expectSoon?: boolean } = {},
): UseQueryResult<RepurposeEpisodePackView> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const expectSoon = options.expectSoon === true;
  return useQuery({
    queryKey: episodePackQueryKey(workspaceId ?? "none", runId ?? "none"),
    enabled: workspaceId !== null && runId !== null,
    retry: (failureCount: number, error: Error) =>
      !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2,
    refetchInterval: (query) => episodePackPollDelay(query.state.data, expectSoon),
    queryFn: () => client.call(episodePackEndpoint, { params: { runId: runId ?? "" } }),
  });
}

/** Write the run's episode text now, or again after it failed. Resolves with the view. */
export function useWriteEpisodePack(): UseMutationResult<RepurposeEpisodePackView, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (runId: string) => client.call(writeEpisodePackEndpoint, { params: { runId } }),
    onSuccess: (view) => {
      if (workspaceId === null) return;
      queryClient.setQueryData(episodePackQueryKey(workspaceId, view.runId), view);
    },
  });
}
