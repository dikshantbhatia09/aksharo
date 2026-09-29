/**
 * Compilations and series on the run page (2026-10-03): which clips can be
 * joined in a shape, "Best of this video", the order list, and the words for
 * each state.
 *
 * `COMPILATION_LIMITS` and `compilationOutputMs` are copies of the ones in
 * `@montaj/repurpose-contracts` (the page does not depend on that package);
 * `compilations.test.ts` holds them equal, as `formats.test.ts` does the formats.
 */
import type {
  RepurposeCandidateItem,
  RepurposeClipItem,
  RepurposeCompilation,
  RepurposeCompilationShape,
} from "@montaj/api-client";

export const COMPILATION_LIMITS = Object.freeze({
  minClips: 2,
  maxClips: 20,
  maxOutputMs: 15 * 60_000,
  titleMax: 80,
  introMs: 2_000,
  fadeMs: 500,
  fps: 30,
});

export const SERIES_LIMITS = Object.freeze({ minClips: 2, maxClips: 10 });

/** The joined video's length: every clip and the card, less one fade a join (whole frames). */
export function compilationOutputMs(input: {
  readonly clipsMs: readonly number[];
  readonly introMs?: number;
  readonly fadeMs?: number;
  readonly fps?: number;
}): number {
  const fps = input.fps ?? COMPILATION_LIMITS.fps;
  const frames = (ms: number): number => Math.max(0, Math.round((ms * fps) / 1000));
  const parts = [...(input.introMs === undefined ? [] : [input.introMs]), ...input.clipsMs];
  if (parts.length === 0) return 0;
  const fade = frames(input.fadeMs ?? COMPILATION_LIMITS.fadeMs);
  const total = parts.reduce((sum, ms) => sum + frames(ms), 0) - fade * (parts.length - 1);
  return Math.max(0, Math.round((total * 1000) / fps));
}

export const COMPILATION_SHAPES: readonly RepurposeCompilationShape[] = [
  "9:16",
  "4:5",
  "1:1",
  "16:9",
];

export const SHAPE_LABELS: Readonly<Record<RepurposeCompilationShape, string>> = Object.freeze({
  "9:16": "Vertical 9:16",
  "4:5": "Portrait 4:5",
  "1:1": "Square 1:1",
  "16:9": "Landscape 16:9",
});

/** How long "Best of this video" aims for, and the default for each shape. */
export const BEST_OF_TARGETS = [
  { ms: 60_000, label: "About 1 minute" },
  { ms: 3 * 60_000, label: "About 3 minutes" },
  { ms: 10 * 60_000, label: "About 10 minutes" },
] as const;

export function defaultBestOfMs(shape: RepurposeCompilationShape): number {
  return shape === "16:9" ? 3 * 60_000 : 60_000;
}

/** A clip as the builder offers it. */
export interface PickableClip {
  readonly clipId: string;
  readonly title: string;
  /** Where the moment starts in the video: the order "Best of" plays in. */
  readonly startMs: number;
  /** Its captioned video's length in the shape. */
  readonly durationMs: number;
  /** The moment's potential score; null for a person's own pick. */
  readonly potential: number | null;
}

/**
 * The clips whose captioned video in `shape` is made: only those can be joined
 * (the API holds to the same rule). Listed in the video's order.
 */
export function pickableClips(
  clips: readonly RepurposeClipItem[],
  candidates: readonly RepurposeCandidateItem[],
  shape: RepurposeCompilationShape,
): PickableClip[] {
  const byCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const pickable: PickableClip[] = [];
  for (const clip of clips) {
    if (clip.state !== "ready") continue;
    const candidate =
      clip.candidateId === undefined ? undefined : byCandidate.get(clip.candidateId);
    if (candidate !== undefined && candidate["state"] === "rejected") continue;
    const format = (clip.formats ?? []).find((entry) => entry.shape === shape);
    const captioned = format?.status === "ready" ? format.captioned : null;
    if (captioned === null || captioned.downloadUrl === null) continue;
    const startMs = clip.sourceStartMs ?? candidate?.startMs ?? 0;
    const endMs = clip.sourceEndMs ?? candidate?.endMs ?? startMs;
    const score = candidate?.potentialScore ?? candidate?.score;
    pickable.push({
      clipId: clip.id,
      title: candidate?.title ?? clip.title ?? "Clip",
      startMs,
      durationMs: captioned.durationMs ?? Math.max(0, endMs - startMs),
      potential: typeof score === "number" ? score : null,
    });
  }
  return pickable.sort((a, b) => a.startMs - b.startMs);
}

/** The clips a series can take: every made clip, whatever its shapes. */
export function seriesClips(
  clips: readonly RepurposeClipItem[],
  candidates: readonly RepurposeCandidateItem[],
): Set<string> {
  const removed = new Set(
    candidates.filter((candidate) => candidate["state"] === "rejected").map((c) => c.id),
  );
  return new Set(
    clips
      .filter((clip) => clip.state === "ready" && !removed.has(clip.candidateId ?? ""))
      .map((clip) => clip.id),
  );
}

/**
 * "Best of this video": the strongest clips (by potential, a person's own picks
 * after the scored ones) while the joined video stays within `targetMs`, at
 * least two when there are two - then put back in the video's order, so the
 * best-of tells the video's story.
 */
export function bestOf(
  pickable: readonly PickableClip[],
  targetMs: number,
  withTitle: boolean,
): string[] {
  const ranked = [...pickable].sort(
    (a, b) => (b.potential ?? -1) - (a.potential ?? -1) || a.startMs - b.startMs,
  );
  const chosen: PickableClip[] = [];
  for (const clip of ranked) {
    if (chosen.length >= COMPILATION_LIMITS.maxClips) break;
    const next = [...chosen, clip];
    const length = plannedMs(
      next.map((entry) => entry.durationMs),
      withTitle,
    );
    if (length > COMPILATION_LIMITS.maxOutputMs) continue;
    if (length > targetMs && chosen.length >= COMPILATION_LIMITS.minClips) continue;
    chosen.push(clip);
  }
  return chosen.sort((a, b) => a.startMs - b.startMs).map((clip) => clip.clipId);
}

export function plannedMs(durations: readonly number[], withTitle: boolean): number {
  return compilationOutputMs({
    clipsMs: durations,
    ...(withTitle ? { introMs: COMPILATION_LIMITS.introMs } : {}),
  });
}

/** The list with the entry at `index` moved by `by` (one up is -1), kept inside it. */
export function moved<T>(list: readonly T[], index: number, by: number): T[] {
  const target = index + by;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [entry] = next.splice(index, 1);
  if (entry !== undefined) next.splice(target, 0, entry);
  return next;
}

/** "1:05" / "12:30". */
export function formatLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

export const COMPILATION_COPY = Object.freeze({
  heading: "Compilations",
  intro: "Join your clips into one video, a short fade between each.",
  make: "Make a compilation",
  builderHeading: "New compilation",
  seriesTab: "Series",
  compilationTab: "Compilation",
  pickHint: "Tick the clips to join, then put them in order.",
  seriesHint:
    "Tick clips that follow each other. They are numbered in the order they play in the video.",
  shape: "Shape",
  bestOf: "Best of this video",
  length: "Length",
  title: "Title card (optional)",
  titleHint:
    "Shown for 2 seconds before the first clip, in your brand kit's colours if you saved one.",
  order: "Order",
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Take out",
  create: "Make compilation",
  creating: "Starting…",
  createSeries: "Make a series",
  creatingSeries: "Labelling…",
  cancel: "Done picking",
  none: "Nothing picked yet.",
  onlyCaptioned: "Only clips whose captioned video in this shape is made can be joined.",
  tooMany: `Up to ${String(COMPILATION_LIMITS.maxClips)} clips, and 15 minutes.`,
  tooLong: "That is longer than 15 minutes. Take a clip out.",
  needTwo: "Pick at least two clips.",
  seriesTooMany: `A series is 2 to ${String(SERIES_LIMITS.maxClips)} clips.`,
  waiting: "Waiting for a free slot. It starts by itself.",
  rendering: "Being made…",
  expired: "Its video was deleted after 7 days. Make it again to get it back.",
  stale: "A clip changed since this was made.",
  makeAgain: "Make again",
  makeAgainLatest: "Make again with the latest clips",
  download: "Download",
  delete: "Delete",
  deleteTitle: "Delete this compilation?",
  deleteBody: "Its video is deleted. Your clips stay as they are.",
  deleteConfirm: "Delete compilation",
  seriesHeading: "Series",
  removeSeries: "Remove series labels",
  removingSeries: "Removing…",
  seriesPending: "The labels go on the clips' other shapes once those are made.",
  seriesMade: "Each clip now says which part it is. Its videos are being made again.",
});

/** What a failed compilation's code means, in the page's words. */
export function compilationFailureCopy(code: string | null): string {
  switch (code) {
    case "repurpose/compilation_source_gone":
      return "A clip's video changed or is no longer kept. Make it again to use the current clips.";
    case "repurpose/compilation_too_long":
      return "It came out longer than 15 minutes. Take a clip out and make a new one.";
    case "repurpose/compilation_cancelled":
      return "It was stopped before it was made.";
    case "repurpose/compilation_stalled":
      return "It stopped part way through.";
    case "repurpose/compilation_no_credits":
      return "There were not enough credits. Top up, then make it again.";
    default:
      return "It could not be made.";
  }
}

/** A compilation's one-line summary: "Vertical 9:16 · 4 clips · 1:05". */
export function compilationSummary(compilation: RepurposeCompilation): string {
  const clips = compilation.clipIds.length;
  return [
    SHAPE_LABELS[compilation.shape],
    `${String(clips)} ${clips === 1 ? "clip" : "clips"}`,
    ...(compilation.durationMs === null ? [] : [formatLength(compilation.durationMs)]),
  ].join(" · ");
}
