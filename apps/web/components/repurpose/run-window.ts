/**
 * What a run is called, which part of its video it processed, and whether
 * there is more after it (clips pipeline, 2026-09-27).
 *
 * A plan now limits the minutes a run PROCESSES, not the length of the video:
 * a 3-hour podcast on Free is processed 20 minutes at a time, the most-replayed
 * part by default. So a run has to say which part it is ("Processed 12:10–32:10
 * of 34:37"), and offer the next part.
 *
 * The API adds `sourceTitle`, `window`, `failureDetail` and
 * `nextWindowAvailable` to the run view. They are read from the run as plain
 * data here, never assumed: an API older than that answers without them, and
 * the page must render exactly as it did then.
 */
import type { RepurposeRunView } from "@montaj/api-client";

import { DETAIL_COPY } from "@/components/repurpose/copy";
import {
  failureDetailOf,
  spanPhrase,
  type FailureDetail,
} from "@/components/repurpose/failure-detail";
import { formatClock } from "@/components/repurpose/moment-time";

/** The part of the source a run processed, in the source's own timeline. */
export interface RunWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly sourceDurationMs: number;
  /** `first`, `most_replayed` or `range`; anything else is shown without a reason. */
  readonly policy: string;
}

type RunLike = Pick<RepurposeRunView, "sourceDisplay" | "sourceKind">;

function fieldOf(
  run: object,
  key: "sourceTitle" | "window" | "failureDetail" | "nextWindowAvailable",
): unknown {
  // eslint-disable-next-line security/detect-object-injection -- `key` is one of four literals
  return (run as Readonly<Record<string, unknown>>)[key];
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The run's name as a person knows the video: its real title, else the safe
 * display (`youtube.com · <id>`), else what kind of source it is.
 *
 * The title is the video's own, so it is shown as text and never trusted for
 * anything else (links are rebuilt from `sourceDisplay`, not from this).
 */
export function runTitle(run: RunLike, fallback?: string): string {
  const title = fieldOf(run, "sourceTitle");
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  return (
    run.sourceDisplay ?? fallback ?? (run.sourceKind === "upload" ? "Your upload" : "Your video")
  );
}

/**
 * The window the run processed, or `null` for the whole source (or an API
 * that does not say). A window that covers the whole video is the whole video.
 */
export function runWindowOf(run: object): RunWindow | null {
  const raw = fieldOf(run, "window");
  if (typeof raw !== "object" || raw === null) return null;
  const { startMs, endMs, sourceDurationMs, policy } = raw as Readonly<Record<string, unknown>>;
  if (!isCount(startMs) || !isCount(endMs) || !isCount(sourceDurationMs)) return null;
  if (endMs <= startMs || sourceDurationMs <= 0) return null;
  // Within a second of both ends is the whole video: nothing worth saying.
  if (startMs < 1000 && endMs >= sourceDurationMs - 1000) return null;
  return {
    startMs,
    endMs: Math.min(endMs, sourceDurationMs),
    sourceDurationMs,
    policy: typeof policy === "string" ? policy : "",
  };
}

/**
 * Statuses before a run has its moments: the API's `PRE_CANDIDATE_STATUSES`.
 * The section lands at the start of these, so a run in one of them has a
 * window it is still working through.
 */
const PRE_CANDIDATE: ReadonlySet<string> = new Set([
  "draft",
  "acquiring",
  "preparing_media",
  "transcribing",
  "analyzing",
]);

/**
 * How a run's part is spoken of: `working` while the run is still getting
 * through it ("Processing"), `stopped` once it failed or was stopped, which
 * says which part it was and claims nothing about it ("Part"), else `done`
 * ("Processed"). "Processed 12:10–32:10" over a run still transcribing, or
 * one that failed, said something that had not happened.
 */
export type WindowPhase = "working" | "stopped" | "done";

export function windowPhase(run: Pick<RepurposeRunView, "status">): WindowPhase {
  if (run.status === "failed" || run.status === "cancelled") return "stopped";
  return PRE_CANDIDATE.has(run.status) ? "working" : "done";
}

/** "Processed 12:10–32:10 of 34:37 (most replayed)", in the run's own tense. */
export function windowSummary(part: RunWindow, phase: WindowPhase = "done"): string {
  const reasons: Readonly<Record<string, string>> = DETAIL_COPY.policy;
  // A policy this build does not know is shown without a reason, not as its code.
  const reason = Object.hasOwn(reasons, part.policy) ? reasons[part.policy] : undefined;
  const sentence =
    phase === "working"
      ? DETAIL_COPY.processing
      : phase === "stopped"
        ? DETAIL_COPY.part
        : DETAIL_COPY.processed;
  return sentence(
    formatClock(part.startMs),
    formatClock(part.endMs),
    formatClock(part.sourceDurationMs),
    reason,
  );
}

/**
 * "Part 12:10–32:10", for a list or a banner: two parts of one podcast carry
 * the same title, and without it they read as the same run twice. `null` for
 * a run over the whole video (or before its part is known).
 */
export function runPartLabel(run: object): string | null {
  const part = runWindowOf(run);
  return part === null
    ? null
    : DETAIL_COPY.partRange(formatClock(part.startMs), formatClock(part.endMs));
}

/**
 * How much the next run would process: the plan's window when it is known,
 * else as much as this run did, and never more than what is left of the video.
 *
 * The server decides the real window, and a low balance can shorten it; this
 * is only the button's promise. The plan's window is preferred because this
 * run's own length can be stale: a plan that changed since, or a run that the
 * balance cut short.
 */
export function nextWindowSpanMs(part: RunWindow, planWindowMs?: number): number {
  const perRun =
    planWindowMs !== undefined && Number.isFinite(planWindowMs) && planWindowMs > 0
      ? planWindowMs
      : part.endMs - part.startMs;
  return Math.max(0, Math.min(perRun, part.sourceDurationMs - part.endMs));
}

/**
 * "Process the next 20 minutes", when the run says there is a next part AND
 * this one is past its early stages.
 *
 * The API reports a next part as soon as this run's section lands, which is
 * while it is still being prepared and transcribed. A second run of the same
 * video started then competes with this one for the one download at a time
 * and the plan's job slots, and can stall the run the person is watching; so
 * the offer waits until this run has its moments, or has stopped.
 */
export function nextWindowOffer(
  run: Pick<RepurposeRunView, "status">,
  planWindowMs?: number,
): { readonly label: string } | null {
  if (fieldOf(run, "nextWindowAvailable") !== true) return null;
  if (windowPhase(run) === "working") return null;
  const part = runWindowOf(run);
  if (part === null) return null;
  const span = nextWindowSpanMs(part, planWindowMs);
  return span <= 0 ? null : { label: DETAIL_COPY.nextWindow(spanPhrase(span)) };
}

/**
 * Which part a retry of this run will fetch, as far as the page can tell.
 *
 * The API's retry re-uses the run's own request: a start the person picked
 * stays that start (`range`), and otherwise it chooses again (the most-replayed
 * part when YouTube marks one, else the start). The run view does not carry
 * the request, so it is read from what the page has: this browser's memory of
 * the run's setup, or the part that already landed.
 *
 *   * `range` — a picked start, with where it was;
 *   * `auto` — known to have had no picked start;
 *   * `unknown` — neither (a run from another browser that failed before its
 *     part landed): the card then promises only a length, never which part.
 */
export type RetryWindow =
  | { readonly kind: "range"; readonly startMs: number }
  | { readonly kind: "auto" }
  | { readonly kind: "unknown" };

export function retryWindowOf(
  run: object,
  remembered: { readonly startMs?: number } | undefined,
): RetryWindow {
  const landed = runWindowOf(run);
  if (landed?.policy === "range") return { kind: "range", startMs: landed.startMs };
  if (remembered !== undefined) {
    return isCount(remembered.startMs)
      ? { kind: "range", startMs: remembered.startMs }
      : { kind: "auto" };
  }
  if (landed?.policy === "most_replayed" || landed?.policy === "first") return { kind: "auto" };
  return { kind: "unknown" };
}

/** The numbers behind the run's failure, if the API sent any. */
export function runFailureDetail(run: object): FailureDetail | null {
  return failureDetailOf(fieldOf(run, "failureDetail"));
}
