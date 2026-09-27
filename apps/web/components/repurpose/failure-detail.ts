/**
 * The numbers behind a failed run, and what the card says with them.
 *
 * A refusal used to reach the page as a bare code: "This video is longer than
 * your plan allows", with no length, no limit and only "Choose another video"
 * (`copy.ts` said the page "only knows it was over"). A clips product's normal
 * input is 30 minutes to 3 hours, so that was a dead end on the ordinary path.
 * The API now carries the facts the worker refused on (`failureDetail` on the
 * run, from the job error's `facts`), and a too-long link is never a dead end:
 * the run can process a window of it instead (owner decision, 2026-09-27).
 *
 * Everything here is read defensively. The detail is a flat record written by
 * three layers, an older API sends none, and a card must still say something
 * true with whatever subset arrived — so a missing or nonsensical number drops
 * that sentence back to the plain one in `copy.ts`, never to "NaN:NaN".
 */
import { DETAIL_COPY } from "@/components/repurpose/copy";
import { formatClock } from "@/components/repurpose/moment-time";

export interface FailureDetail {
  /** The source's own length. */
  readonly durationMs?: number;
  /** The length limit that was exceeded (the plan's cap, or the source ceiling). */
  readonly maxDurationMs?: number;
  /** The plan's file-size cap. */
  readonly maxBytes?: number;
  /** The smallest download the source offered, when it was over `maxBytes`. */
  readonly approximateBytes?: number;
  /** How much of a video the plan processes per run. */
  readonly windowMs?: number;
  /** The balance when the run was refused for credits. */
  readonly creditsLeft?: number;
}

/**
 * The longest video anyone can send, whatever the plan (`maxSourceDurationMs`,
 * owner decision 2026-09-27). A plan whose window reaches it processes every
 * video it takes whole, and a start at or past it can only be a typo.
 */
export const SOURCE_CEILING_MS = 12 * 60 * 60 * 1000;

const DETAIL_KEYS = [
  "durationMs",
  "maxDurationMs",
  "maxBytes",
  "approximateBytes",
  "windowMs",
  "creditsLeft",
] as const;

/**
 * A `failureDetail` (or a refusal's `details`) as numbers this page can print:
 * finite and not negative. Anything else is dropped key by key, and a record
 * with nothing usable is `null`.
 */
export function failureDetailOf(value: unknown): FailureDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Readonly<Record<string, unknown>>;
  const detail: { -readonly [K in keyof FailureDetail]: number } = {};
  for (const key of DETAIL_KEYS) {
    // eslint-disable-next-line security/detect-object-injection -- `key` is one of the six literals above
    const raw = source[key];
    // eslint-disable-next-line security/detect-object-injection -- the same literal key
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) detail[key] = raw;
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

/** "1 credit", "3.5 credits": rounded down, so the balance is never overstated. */
export function formatCredits(credits: number): string {
  const shown = Math.floor(Math.max(0, credits) * 10) / 10;
  const text = Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
  return shown === 1 ? "1 credit" : `${text} credits`;
}

/** A size as a person reads it: "500 MB", "2 GB", "1.5 GB". */
export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * A stretch of video in words, for a button: "20 minutes", "3 hours".
 *
 * Whole hours read as hours past 90 minutes; anything else stays in minutes,
 * because "2.5 hours" is harder to hold against a clock than "150 minutes".
 * Minutes round DOWN: a button that says "the next 3 minutes" over 2:27 of
 * video left would promise what is not there.
 */
export function spanPhrase(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds === 1 ? "1 second" : `${String(seconds)} seconds`;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes > 90 && minutes % 60 === 0) return `${String(minutes / 60)} hours`;
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}

/**
 * What a too-long refusal was about.
 *
 *   * `window` — longer than the part a run processes: a part of it works (the
 *     ordinary case). The API reports it as `windowMs`, with `maxDurationMs`
 *     equal to it when the landed file overran its window (an old downloader
 *     that fetched the whole video, which a retry with a new one fixes);
 *   * `ceiling` — longer than any video the service takes (12 h, the source
 *     ceiling): no part helps, so none is offered. A download is refused on
 *     length only for this — a longer-than-the-window video is windowed, never
 *     refused — so a limit with no `windowMs` beside it is the ceiling, and so
 *     is one longer than the window;
 *   * `length` — only the video's length is known.
 */
export type TooLongFacts =
  | { readonly kind: "window"; readonly durationMs: number; readonly windowMs: number }
  | { readonly kind: "ceiling"; readonly durationMs: number; readonly maxMs: number }
  | { readonly kind: "length"; readonly durationMs: number };

export function tooLongFacts(detail: FailureDetail | null | undefined): TooLongFacts | null {
  const durationMs = detail?.durationMs;
  if (durationMs === undefined || durationMs <= 0) return null;
  const windowMs =
    detail?.windowMs !== undefined && detail.windowMs > 0 ? detail.windowMs : undefined;
  const maxMs =
    detail?.maxDurationMs !== undefined && detail.maxDurationMs > 0
      ? detail.maxDurationMs
      : undefined;
  // Over a limit that is not the window itself: that limit is the ceiling.
  if (maxMs !== undefined && durationMs > maxMs && (windowMs === undefined || windowMs < maxMs)) {
    return { kind: "ceiling", durationMs, maxMs };
  }
  if (windowMs !== undefined && durationMs > windowMs)
    return { kind: "window", durationMs, windowMs };
  return { kind: "length", durationMs };
}

/** What the numbers change on a failure card; every field falls back to `copy.ts`. */
export interface DetailedFailure {
  readonly title?: string;
  readonly reassurance?: string;
  /**
   * For a too-long video: whether processing part of it can work at all.
   * False only when it is over the source ceiling, where no window helps.
   */
  readonly windowPossible: boolean;
  /** The plan's window, when known, for "Process 20 minutes of it". */
  readonly windowMs?: number;
}

export function detailedFailure(
  code: string | null,
  detail: FailureDetail | null,
): DetailedFailure {
  if (code === "repurpose/source_too_long") {
    const facts = tooLongFacts(detail);
    if (facts === null) return { windowPossible: true };
    const length = formatClock(facts.durationMs);
    switch (facts.kind) {
      case "window":
        return {
          title: DETAIL_COPY.tooLongWindow(length, formatClock(facts.windowMs)),
          windowPossible: true,
          windowMs: facts.windowMs,
        };
      case "ceiling":
        return {
          title: DETAIL_COPY.tooLongLimit(length, spanPhrase(facts.maxMs)),
          windowPossible: false,
        };
      default:
        return { title: DETAIL_COPY.tooLongLength(length), windowPossible: true };
    }
  }
  if (code === "repurpose/source_too_large") {
    const max = detail?.maxBytes !== undefined && detail.maxBytes > 0 ? detail.maxBytes : undefined;
    const size =
      detail?.approximateBytes !== undefined && detail.approximateBytes > 0
        ? detail.approximateBytes
        : undefined;
    if (max === undefined) return { windowPossible: false };
    return {
      title:
        size === undefined || size <= max
          ? DETAIL_COPY.tooLargeCapOnly(formatBytes(max))
          : DETAIL_COPY.tooLarge(formatBytes(size), formatBytes(max)),
      windowPossible: false,
    };
  }
  if (code === "repurpose/no_credits" && detail?.creditsLeft !== undefined) {
    return {
      reassurance: DETAIL_COPY.creditsLeftReassurance(formatCredits(detail.creditsLeft)),
      windowPossible: false,
    };
  }
  return { windowPossible: false };
}
