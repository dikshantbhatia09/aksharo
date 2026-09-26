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
      return "repurpose/highlights_failed";
  }
}

/** `jobs.error` is JSON; its `code`, when it has one. */
export function jobErrorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}
