import { CLIP_LENGTH_PRESETS, ClipLengthPresetSchema } from "@montaj/repurpose-contracts";

import { MAX_CLIP_MS, MIN_CLIP_MS } from "./repurpose-clips.dto.js";
import {
  AUTOPILOT_MAX_CLIPS,
  DEFAULT_MAX_CANDIDATE_MS,
  DEFAULT_MIN_CANDIDATE_MS,
} from "./repurpose.constants.js";

/**
 * Steering (2026-09-29): what a person tells a run about the clips they want,
 * and what they do to the clips it made. Pure functions only - the services
 * that read and write rows call these, so every rule here is testable without
 * a database.
 *
 *   * **At the start:** what the clips are about (`topic`), how long they are
 *     (`clipLength`, a `CLIP_LENGTH_PRESETS` band), and how much of the start
 *     and end of the video to leave out (`skipIntroMs`, `skipOutroMs`).
 *   * **Autopilot's reserve:** discovery is asked for about a third more
 *     moments than Autopilot cuts. The extra ones wait, uncut, and the best of
 *     them takes the place of a clip the person removes.
 *   * **After the cut:** a clip's start and end can be moved, and are snapped
 *     to the words either side so a cut never lands mid-word.
 */

export type ClipLength = keyof typeof CLIP_LENGTH_PRESETS;

/** The most of the start, or of the end, a run may skip: the create request's own bound. */
export const MAX_SKIP_MS = 30 * 60_000;

/**
 * What a run was steered with, as its page shows it ("About: money habits ·
 * Short clips"). A skip of zero is no skip.
 */
export interface RunSteering {
  readonly topic: string | null;
  readonly clipLength: ClipLength | null;
  readonly skipIntroMs: number;
  readonly skipOutroMs: number;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clipLengthOf(value: unknown): ClipLength | null {
  const parsed = ClipLengthPresetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A skip as the create request bounds it, or 0 for anything else. */
function skipOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_SKIP_MS
    ? value
    : 0;
}

function topicOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const topic = value.trim();
  return topic.length >= 2 && topic.length <= 200 ? topic : null;
}

/**
 * A run's steering, read back from its frozen `config.discovery`; null when it
 * has none (every run from before steering, and every run started without it).
 */
export function steeringOf(config: unknown): RunSteering | null {
  const discovery = recordOf(recordOf(config)["discovery"]);
  const steering: RunSteering = {
    topic: topicOf(discovery["topic"]),
    clipLength: clipLengthOf(discovery["clipLength"]),
    skipIntroMs: skipOf(discovery["skipIntroMs"]),
    skipOutroMs: skipOf(discovery["skipOutroMs"]),
  };
  return steering.topic === null &&
    steering.clipLength === null &&
    steering.skipIntroMs === 0 &&
    steering.skipOutroMs === 0
    ? null
    : steering;
}

/**
 * The discovery setup a run freezes: with a `clipLength`, its preset's band
 * written into `minDurationMs`/`maxDurationMs` too, so the frozen config says
 * the same thing to a reader that knows nothing of presets. A preset wins over
 * bounds sent beside it - it is what the person chose on the form.
 */
export function withLengthPreset<
  T extends {
    readonly clipLength?: ClipLength | undefined;
    readonly minDurationMs?: number;
    readonly maxDurationMs?: number;
  },
>(discovery: T): T {
  if (discovery.clipLength === undefined) return discovery;
  return { ...discovery, ...CLIP_LENGTH_PRESETS[discovery.clipLength] };
}

function boundOf(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CLIP_MS &&
    value <= MAX_CLIP_MS
    ? value
    : null;
}

/**
 * How long discovery's moments may be, for a run's frozen `config.discovery`:
 * the preset's band when it names one, else the bounds it recorded, else the
 * defaults every run had before (15-60 s).
 */
export function discoveryBoundsOf(discovery: unknown): {
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
} {
  const record = recordOf(discovery);
  const preset = clipLengthOf(record["clipLength"]);
  // eslint-disable-next-line security/detect-object-injection -- a parsed ClipLength, one of three literal keys
  if (preset !== null) return { ...CLIP_LENGTH_PRESETS[preset] };
  const min = boundOf(record["minDurationMs"]) ?? DEFAULT_MIN_CANDIDATE_MS;
  const max = boundOf(record["maxDurationMs"]) ?? DEFAULT_MAX_CANDIDATE_MS;
  return min <= max
    ? { minDurationMs: min, maxDurationMs: max }
    : { minDurationMs: DEFAULT_MIN_CANDIDATE_MS, maxDurationMs: DEFAULT_MAX_CANDIDATE_MS };
}

export interface ExcludeRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * "Skip the first 2 min" and "skip the last 5 min" as `ai.highlights`'
 * `excludeRanges`, on the clock its words are timed on.
 *
 * That clock is the PROCESSED FILE's, not the video's: a long link is fetched
 * a window at a time (CLAUDE.md §17), the landed file starts at 0:00, and the
 * transcript, the moments and the cuts all run on it. Where the file sits in
 * the video is `media_assets.source_offset_ms` (the acquisition writes it for
 * every link; an upload is the whole video, offset 0).
 *
 * The skips are about the VIDEO - its intro, its sponsor read, its outro - so
 * each is placed in the video first and then moved onto the file's clock:
 *
 *   * the intro is `[0, skipIntroMs)` of the video: in the file only when the
 *     file starts before it ends. The next part of a long video, which starts
 *     at 20:00, is not trimmed again.
 *   * the outro is the last `skipOutroMs` of the video, which needs the
 *     video's length: `repurpose_runs.source_duration_ms`, or the file's own
 *     length when the file is the whole video. A part of a longer video whose
 *     length was never reported is left alone - better a clip from the credits
 *     than none from real content.
 *
 * Every range is cut to the file and dropped when nothing of it is left.
 */
export function excludeRangesFor(input: {
  readonly skipIntroMs: number;
  readonly skipOutroMs: number;
  /** Where the processed file starts in the video; 0 for the whole video. */
  readonly offsetMs: number;
  /** The processed file's length, when probed. */
  readonly fileDurationMs: number | null;
  /** The whole video's length, when the download reported it. */
  readonly sourceDurationMs: number | null;
}): ExcludeRange[] {
  const offset = Math.max(0, Math.round(input.offsetMs));
  const file =
    input.fileDurationMs !== null && input.fileDurationMs > 0
      ? Math.round(input.fileDurationMs)
      : null;
  const video =
    input.sourceDurationMs !== null && input.sourceDurationMs > 0
      ? Math.round(input.sourceDurationMs)
      : offset === 0
        ? file
        : null;
  const ranges: ExcludeRange[] = [];
  const push = (startMs: number, endMs: number): void => {
    const start = Math.max(0, Math.round(startMs));
    const end = Math.round(file === null ? endMs : Math.min(endMs, file));
    if (end > start) ranges.push({ startMs: start, endMs: end });
  };

  const intro = skipOf(input.skipIntroMs);
  if (intro > offset) push(0, intro - offset);

  const outro = skipOf(input.skipOutroMs);
  if (outro > 0 && video !== null) {
    // The file ends where the video does, or before: nothing past it is timed.
    push(video - outro - offset, file ?? video - offset);
  }
  return ranges;
}

/**
 * The steering part of an `ai.highlights` payload's `options`: the topic, and
 * the skipped start and end as {@link excludeRangesFor} places them. Empty for
 * a run that was not steered, so its payload is exactly what it was before.
 */
export function steeringOptionsOf(input: {
  readonly config: unknown;
  /** `media_assets.source_offset_ms`, else the run's window start. */
  readonly offsetMs: number | null;
  readonly fileDurationMs: number | null;
  readonly sourceDurationMs: number | null;
}): { readonly topic?: string; readonly excludeRanges?: ExcludeRange[] } {
  const steering = steeringOf(input.config);
  if (steering === null) return {};
  // The contract takes twenty; two is all the form can make.
  const ranges = excludeRangesFor({
    skipIntroMs: steering.skipIntroMs,
    skipOutroMs: steering.skipOutroMs,
    offsetMs: input.offsetMs ?? 0,
    fileDurationMs: input.fileDurationMs,
    sourceDurationMs: input.sourceDurationMs,
  }).slice(0, 20);
  return {
    ...(steering.topic === null ? {} : { topic: steering.topic }),
    ...(ranges.length === 0 ? {} : { excludeRanges: ranges }),
  };
}

/**
 * Autopilot's reserve: discovery is asked for about this many more moments
 * than Autopilot cuts ({@link autopilotAskCount}), so a clip the person removes
 * is replaced by the best one left rather than by nothing.
 */
export const AUTOPILOT_RESERVE_RATIO = 0.3;

/**
 * How many moments to ask discovery for, when Autopilot will cut `target` of
 * them: the target and about a third more, never past the contract's forty.
 */
export function autopilotAskCount(target: number): number {
  const wanted = Math.max(0, Math.floor(target));
  return Math.min(AUTOPILOT_MAX_CLIPS, wanted + Math.ceil(wanted * AUTOPILOT_RESERVE_RATIO));
}

/** A moment as Autopilot's choice reads it. */
export interface PickableCandidate {
  readonly id: string;
  readonly source: string;
  readonly state: string;
  readonly rank: number | null;
  readonly potentialScore: number | null;
  readonly startMs: number;
}

/**
 * A moment the person removed (`clip_candidates.state = 'rejected'`). Its clip
 * row is kept, so "Restore" brings it back as it was; everything that would
 * make or re-make something for it passes it by.
 */
export function isRemoved(
  candidate: { readonly state?: string | null } | null | undefined,
): boolean {
  return candidate?.state === "rejected";
}

/** Best first: discovery's rank, then potential, then time. */
function bestFirst(a: PickableCandidate, b: PickableCandidate): number {
  const rank = (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY);
  if (rank !== 0 && Number.isFinite(rank)) return rank;
  if (a.rank === null && b.rank !== null) return 1;
  if (b.rank === null && a.rank !== null) return -1;
  const potential = (b.potentialScore ?? -1) - (a.potentialScore ?? -1);
  if (potential !== 0) return potential;
  return a.startMs - b.startMs;
}

/**
 * The moments Autopilot gives a clip now, best first (2026-09-29).
 *
 * Discovery returns the `target` it was asked for and a reserve. Autopilot
 * cuts the best `target` suggestions: a suggestion that already has a clip
 * (and was not removed) holds one of those places, so removing a clip opens a
 * place and the best uncut suggestion takes it. A moment the person added by
 * time is always cut - they asked for that one - and never counts against
 * the target. A removed moment is never picked. `room` is what the run's clip
 * cap still allows.
 */
export function autopilotPicks<T extends PickableCandidate>(input: {
  readonly candidates: readonly T[];
  /** Candidates that already have a clip row, removed or not. */
  readonly withClip: ReadonlySet<string>;
  readonly target: number;
  readonly room: number;
}): T[] {
  const live = input.candidates.filter((candidate) => !isRemoved(candidate));
  const suggested = live.filter((candidate) => candidate.source !== "manual").sort(bestFirst);
  const held = suggested.filter((candidate) => input.withClip.has(candidate.id)).length;
  const open = Math.max(0, Math.floor(input.target) - held);
  const picks = [
    ...suggested.filter((candidate) => !input.withClip.has(candidate.id)).slice(0, open),
    ...live.filter(
      (candidate) => candidate.source === "manual" && !input.withClip.has(candidate.id),
    ),
  ];
  return picks.slice(0, Math.max(0, input.room));
}

/** A transcript word as the snapping reads it (`@montaj/edg` `Word`). */
export interface SnapWord {
  readonly wid: string;
  readonly s: number;
  readonly e: number;
  readonly t?: string;
  readonly deleted?: boolean;
}

/**
 * Up to 2,000 characters of what is said inside `[startMs, endMs]`, for the
 * moment's card - the same reading `RepurposeClipsService` gives a moment
 * added by time.
 */
export function excerptOf(words: readonly SnapWord[], startMs: number, endMs: number): string {
  return words
    .filter((word) => word.deleted !== true && word.s >= startMs && word.e <= endMs)
    .map((word) => word.t ?? "")
    .filter((text) => text !== "")
    .join(" ")
    .slice(0, 2_000);
}

export interface SnappedBounds {
  readonly startMs: number;
  readonly endMs: number;
  /** The words the bounds were snapped to; null for a side with no word near it. */
  readonly startWordId: string | null;
  readonly endWordId: string | null;
}

/**
 * How far from a requested time a word edge is still "that time". The page
 * nudges by one or five seconds, and in speech a word edge is never more than
 * a few hundred ms away. A time with no edge this near is in a pause or in
 * music, where no word is cut, and it stays as asked - snapping it to a word
 * several seconds off would turn a one-second nudge into a jump.
 */
export const SNAP_REACH_MS = 1_000;

interface Edge {
  readonly at: number;
  readonly wid: string | null;
}

/**
 * Where one side of a moment may land, most preferred first.
 *
 * A side the person did not move stays exactly where it is: snapping it too
 * would shift a start nobody touched. A moved side goes to the word edge
 * nearest the requested time, within {@link SNAP_REACH_MS} - but never back
 * onto where it already was or behind it, or the nudge would do nothing. The
 * requested time itself comes last.
 */
function sideChoices(
  edges: readonly { readonly at: number; readonly wid: string }[],
  requested: number,
  current: Edge | null,
): Edge[] {
  if (current !== null && requested === current.at) return [current];
  const near = edges
    .filter((edge) => Math.abs(edge.at - requested) <= SNAP_REACH_MS)
    .sort((a, b) => Math.abs(a.at - requested) - Math.abs(b.at - requested) || a.at - b.at);
  const onward =
    current === null
      ? near
      : near.filter((edge) => (edge.at - current.at) * (requested - current.at) > 0);
  return [...onward, { at: requested, wid: null }];
}

/**
 * A moment's new start and end, snapped to the words: the start to the
 * nearest word START, the end to the nearest word END, so a cut never begins
 * or ends inside a word (2026-09-29, "adjust start and end").
 *
 * `current` is the moment as it is, so a side that was not moved is left alone
 * and a moved one is never snapped back onto its old place ({@link sideChoices}).
 * The most preferred pair that makes a valid moment wins: `minMs`-`maxMs` long
 * (the contract's 3-180 s), starting at or after 0:00 and ending by
 * `durationMs` (an end past it is cut to it, as the cut itself would be).
 * Snapping can push a moment just past a bound (a nudge to exactly 3:00 that
 * snaps a word later), so the next choices are tried before the request is
 * refused. Only timed words count: a deleted word, or one with no length, is
 * not where anything is said.
 *
 * @returns null when no choice near the request makes a valid moment.
 */
export function snapToWords(
  words: readonly SnapWord[],
  requested: { readonly startMs: number; readonly endMs: number },
  current: {
    readonly startMs: number;
    readonly endMs: number;
    readonly startWordId: string | null;
    readonly endWordId: string | null;
  } | null,
  limits: {
    readonly minMs: number;
    readonly maxMs: number;
    readonly durationMs: number | null;
  },
): SnappedBounds | null {
  const timed = words.filter(
    (word) =>
      word.deleted !== true &&
      Number.isFinite(word.s) &&
      Number.isFinite(word.e) &&
      word.e > word.s &&
      word.s >= 0,
  );
  const end = limits.durationMs !== null && limits.durationMs > 0 ? limits.durationMs : null;
  const clampEnd = (at: number): number => (end === null ? at : Math.min(at, end));
  const starts = sideChoices(
    timed.map((word) => ({ at: word.s, wid: word.wid })),
    Math.max(0, Math.round(requested.startMs)),
    current === null ? null : { at: current.startMs, wid: current.startWordId },
  );
  const ends = sideChoices(
    timed.map((word) => ({ at: word.e, wid: word.wid })),
    clampEnd(Math.round(requested.endMs)),
    current === null ? null : { at: current.endMs, wid: current.endWordId },
  );

  // The pair whose choices are the most preferred overall; a tie goes to the
  // better start. Both lists are short (the words within ten seconds).
  let best: SnappedBounds | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const [i, start] of starts.entries()) {
    for (const [j, finish] of ends.entries()) {
      if (i + j >= bestRank) continue;
      const startMs = Math.round(start.at);
      // A word that runs a few ms past the probed length ends where the video does.
      const endMs = Math.round(clampEnd(finish.at));
      const length = endMs - startMs;
      if (startMs < 0 || length < limits.minMs || length > limits.maxMs) continue;
      best = { startMs, endMs, startWordId: start.wid, endWordId: finish.wid };
      bestRank = i + j;
    }
  }
  return best;
}

/**
 * The bounds part of a cut's job key (`media.clip:{candidate}:{bounds}:...`
 * and the format cuts' `media.clip.format:{candidate}:{shape}:{bounds}:...`):
 * the moment's start and its end, cut to the source's length as the cut
 * itself is. A moment whose times were changed is cut under new bounds, so
 * the cuts made for its old times are not this cut's (2026-09-29).
 */
export function cutBoundsOf(
  candidate: { readonly startMs: number; readonly endMs: number },
  sourceDurationMs: number | null,
): string {
  const endMs = Math.min(candidate.endMs, sourceDurationMs ?? candidate.endMs);
  return `${String(candidate.startMs)}-${String(endMs)}`;
}
