import type { SAFE_ERROR_CODES } from "@montaj/repurpose-contracts";

import type { Stage } from "./repurpose.projection.js";

/**
 * Why a run stopped, in the one vocabulary every surface shares (clips
 * hardening 2026-09-26, `docs/repurpose/CLIPS-HARDENING-2026-09-26.md` §2).
 *
 * The worker names what went wrong with the file (`media_assets.failure_reason`,
 * a closed set), the job names what went wrong with the work (`jobs.error.code`),
 * and the run carries ONE code from `SAFE_ERROR_CODES` that the page turns into
 * a sentence and an action. This file is the only place the first two become the
 * third. Before it, three layers each flattened the failure to a constant, and a
 * video that was merely too big for the plan read "We could not get that video —
 * choose another".
 *
 * Pure, no database and no Nest, like the projection: it decides what a person
 * is told, so it is the part worth testing row by row.
 */

/** A run's `failure_code`. Never a worker's or a provider's own words. */
export type RunFailureCode = (typeof SAFE_ERROR_CODES)[number];

/**
 * Codes older code wrote and rows may still carry. Nothing writes them now:
 * `analysis_failed` became `highlights_failed`, and a clip no longer fails its run.
 */
export const LEGACY_RUN_FAILURE_CODES = {
  analysisFailed: "repurpose/analysis_failed",
  clipFailed: "repurpose/clip_failed",
} as const;

/**
 * Where in the pipeline the failure happened. The same media reason means
 * different things at different points: `media/unsupported` from the
 * downloader is a link we could not fetch, from the probe a file we could not
 * read.
 */
export type FailedAt = "acquire" | "processing" | "transcription" | "highlights";

/** The rail stage a failure is shown on: where the person was waiting when it happened. */
export const STAGE_OF_FAILURE: Readonly<Record<FailedAt, Stage>> = Object.freeze({
  acquire: "getting_video",
  processing: "getting_video",
  // Transcription is the first half of "finding clips" on the rail
  // (`STAGE_BY_STATUS.transcribing`), so that is where it stops.
  transcription: "finding_clips",
  highlights: "finding_clips",
});

/**
 * Media reasons that name the source itself, whichever stage reported them.
 * Each has its own sentence and its own next step on the page: too long is
 * "choose a shorter one or upgrade", blocked is "try the same link again in a
 * few minutes", private is "choose another".
 */
const SOURCE_REASONS: Readonly<Record<string, RunFailureCode>> = Object.freeze({
  "media/too_large": "repurpose/source_too_large",
  "media/too_long": "repurpose/source_too_long",
  "media/source_private": "repurpose/source_private",
  "media/source_age_restricted": "repurpose/source_age_restricted",
  "media/source_live": "repurpose/source_live",
  "media/source_removed": "repurpose/source_removed",
  "media/source_blocked": "repurpose/source_blocked",
  "media/source_playlist": "repurpose/source_playlist",
});

/** Job codes that mean the workspace could not pay for the transcription. */
const OUT_OF_CREDITS: ReadonlySet<string> = new Set([
  "credits/insufficient",
  "credits/needs_credits",
]);

/**
 * `ai.highlights`' code for a transcript whose words carry no timings (a Sarvam
 * transcript from before the 2026-09-17 fix, CLAUDE.md §9): no moment can be
 * placed in it. It used to come back as an empty result, and the page said "We
 * did not find a moment worth suggesting", which blamed the video for a broken
 * transcript and never named the fix — transcribing it again.
 */
export const TRANSCRIPT_UNTIMED_JOB_CODE = "worker/transcript_untimed";

/**
 * Job codes that say the work stopped making progress rather than that anything
 * was wrong with the video: the lease reaper's `jobs/stalled` (a worker died
 * holding it), the queue's own `jobs/queue_timeout`, and worker-media's
 * `worker/disk_full` (it waited hours for scratch space). Each reads as a stage
 * that stalled, whose copy says trying again restarts it - not "we could not
 * get that video", which blamed the link (2026-09-27).
 */
const STALLED_JOB_CODES: ReadonlySet<string> = new Set([
  "jobs/stalled",
  "jobs/queue_timeout",
  "worker/disk_full",
]);

function sourceReason(code: string | null | undefined): RunFailureCode | undefined {
  if (code === null || code === undefined) return undefined;
  // eslint-disable-next-line security/detect-object-injection -- lookup in a frozen table; an unknown key simply misses
  return Object.hasOwn(SOURCE_REASONS, code) ? SOURCE_REASONS[code] : undefined;
}

/**
 * The run's failure code for a failure at `failedAt`.
 *
 * The media reason wins over the job code when both name the source: the
 * reason is the closed-set answer the worker wrote for exactly this purpose.
 * The job code is the fallback for when that write never landed (the patch is
 * best effort) or when the job was ended by the API rather than the worker — a
 * queue timeout, a cancel.
 */
export function runFailureCode(input: {
  readonly failedAt: FailedAt;
  /** `media_assets.failure_reason` of the source media, when it failed. */
  readonly mediaReason?: string | null;
  /** `jobs.error.code` of the job that failed, when there is one. */
  readonly jobErrorCode?: string | null;
}): RunFailureCode {
  // A stalled job says nothing about the video, unless the worker also named
  // the source (a refusal it wrote before the lease ran out wins).
  if (
    input.jobErrorCode !== null &&
    input.jobErrorCode !== undefined &&
    STALLED_JOB_CODES.has(input.jobErrorCode) &&
    sourceReason(input.mediaReason) === undefined
  ) {
    return "repurpose/stage_timeout";
  }
  switch (input.failedAt) {
    case "acquire":
      // Anything the downloader could not name — a network error after its
      // retries, a queue timeout, a reason older workers borrowed
      // (`media/unsupported` for "too large", `media/probe_failed` for a bot
      // check) — is "we could not get it", and the page offers the retry.
      return (
        sourceReason(input.mediaReason) ??
        sourceReason(input.jobErrorCode) ??
        "repurpose/source_unavailable"
      );
    case "processing":
      // Downloaded or uploaded, then refused: over the plan's duration cap
      // (which only the probe can measure for a link with no metadata), or a
      // file that could not be read or prepared.
      return sourceReason(input.mediaReason) ?? "repurpose/processing_failed";
    case "transcription":
      return input.jobErrorCode !== null &&
        input.jobErrorCode !== undefined &&
        OUT_OF_CREDITS.has(input.jobErrorCode)
        ? "repurpose/no_credits"
        : "repurpose/transcription_failed";
    case "highlights":
      return input.jobErrorCode === TRANSCRIPT_UNTIMED_JOB_CODE
        ? "repurpose/transcript_untimed"
        : "repurpose/highlights_failed";
  }
}

/**
 * The numbers behind a run's failure (2026-09-27), so the page can say "This
 * video is 34:37; your plan processes 20:00" instead of a bare refusal.
 *
 * `durationMs`/`maxDurationMs`: the source's length and the limit it was held
 * to; `maxBytes`/`approximateBytes`: the size cap and what the smallest
 * acceptable format would have been; `windowMs`: the part of the source the run
 * was allowed to process; `creditsLeft`: the balance, in credits (one decimal).
 */
export interface RunFailureDetail {
  readonly durationMs?: number;
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
  readonly approximateBytes?: number;
  readonly windowMs?: number;
  readonly creditsLeft?: number;
}

export const FAILURE_DETAIL_KEYS = [
  "durationMs",
  "maxDurationMs",
  "maxBytes",
  "approximateBytes",
  "windowMs",
  "creditsLeft",
] as const satisfies readonly (keyof RunFailureDetail)[];

/**
 * The part of `facts` a run may keep and show: the known keys, as finite,
 * non-negative numbers. `facts` comes from a worker (`jobs.error.facts`) or
 * from our own column, and either way is data, not something to echo: an
 * unknown key, a string or a negative number is dropped, never passed on.
 *
 * @returns null when nothing usable is left.
 */
export function failureDetailOf(facts: unknown): RunFailureDetail | null {
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return null;
  const source = facts as Record<string, unknown>;
  const detail: Record<string, number> = {};
  for (const key of FAILURE_DETAIL_KEYS) {
    // eslint-disable-next-line security/detect-object-injection -- `key` is one of the literals above
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      // eslint-disable-next-line security/detect-object-injection -- as above
      detail[key] = value;
    }
  }
  return Object.keys(detail).length === 0 ? null : (detail as RunFailureDetail);
}

/** `jobs.error` is JSON; its `code`, when it has one. */
export function jobErrorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}
