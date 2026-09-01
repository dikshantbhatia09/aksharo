import { assertWholeMs, TimeMapError } from "./errors.js";
import { assertFps, snapToFrame } from "./frames.js";

/**
 * The three things an edit can do to the timeline. Every time is a whole number
 * of milliseconds on the **source** (media) clock, per CONTRACTS §0.
 */
export type EditKind = "cut" | "speed" | "hold";

/** Removes `[startMs, endMs)` from the output. Accepted `cut` pass items become these. */
export interface CutEdit {
  readonly kind: "cut";
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Retimes `[startMs, endMs)`. `factor` is source milliseconds per output
 * millisecond: `2` plays the range twice as fast (half the output length),
 * `0.5` is slow motion (twice the output length).
 */
export interface SpeedEdit {
  readonly kind: "speed";
  readonly startMs: number;
  readonly endMs: number;
  readonly factor: number;
}

/** Freezes the frame at `atMs` for `durationMs` of output, inserting time. */
export interface HoldEdit {
  readonly kind: "hold";
  readonly atMs: number;
  readonly durationMs: number;
}

export type Edit = CutEdit | SpeedEdit | HoldEdit;

/** Builds a `cut` edit. */
export function cutEdit(startMs: number, endMs: number): CutEdit {
  return { kind: "cut", startMs, endMs };
}

/** Builds a `speed` edit; `factor` is source ms per output ms. */
export function speedEdit(startMs: number, endMs: number, factor: number): SpeedEdit {
  return { kind: "speed", startMs, endMs, factor };
}

/** Builds a `hold` (freeze frame) edit. */
export function holdEdit(atMs: number, durationMs: number): HoldEdit {
  return { kind: "hold", atMs, durationMs };
}

/** How `normaliseEdits` should treat frame boundaries. */
export interface NormaliseOptions {
  readonly sourceDurationMs: number;
  readonly fps?: number | undefined;
  readonly snapCutsToFrames?: boolean | undefined;
}

/**
 * Edits after conflict resolution: cuts merged and disjoint, speed ranges clipped
 * out of the cuts, holds that survived. Ordered by source time.
 */
export interface NormalisedEdits {
  readonly cuts: readonly CutEdit[];
  readonly speeds: readonly SpeedEdit[];
  readonly holds: readonly HoldEdit[];
}

function assertEditRange(startMs: number, endMs: number, kind: EditKind): void {
  assertWholeMs(startMs, `${kind}.startMs`);
  assertWholeMs(endMs, `${kind}.endMs`);
  if (startMs > endMs) {
    throw new TimeMapError("invalid-edit", `${kind} runs backwards: ${startMs} > ${endMs}`, {
      kind,
      startMs,
      endMs,
    });
  }
}

/** Splits `edits` by kind, validating each one. */
function partition(edits: readonly Edit[]): {
  cuts: CutEdit[];
  speeds: SpeedEdit[];
  holds: HoldEdit[];
} {
  const cuts: CutEdit[] = [];
  const speeds: SpeedEdit[] = [];
  const holds: HoldEdit[] = [];
  for (const edit of edits) {
    switch (edit.kind) {
      case "cut":
        assertEditRange(edit.startMs, edit.endMs, "cut");
        cuts.push(edit);
        break;
      case "speed":
        assertEditRange(edit.startMs, edit.endMs, "speed");
        if (!Number.isFinite(edit.factor) || edit.factor <= 0) {
          throw new TimeMapError(
            "invalid-factor",
            `speed.factor must be a finite number greater than 0, got ${String(edit.factor)}`,
            { factor: edit.factor },
          );
        }
        speeds.push(edit);
        break;
      case "hold":
        assertWholeMs(edit.atMs, "hold.atMs");
        assertWholeMs(edit.durationMs, "hold.durationMs");
        holds.push(edit);
        break;
      default: {
        const unknown = edit as { kind?: unknown };
        throw new TimeMapError(
          "invalid-edit",
          `unknown edit kind ${JSON.stringify(unknown.kind)}`,
          {
            kind: unknown.kind,
          },
        );
      }
    }
  }
  return { cuts, speeds, holds };
}

/** Merges overlapping and touching cuts into a disjoint, ordered list. */
function mergeCuts(cuts: readonly CutEdit[], durationMs: number): CutEdit[] {
  const clipped = cuts
    .map((cut) => ({
      startMs: Math.min(cut.startMs, durationMs),
      endMs: Math.min(cut.endMs, durationMs),
    }))
    .filter((cut) => cut.endMs > cut.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: CutEdit[] = [];
  for (const cut of clipped) {
    const last = merged[merged.length - 1];
    // Touching cuts (`last.endMs === cut.startMs`) merge too: a splice at the same
    // instant is one splice, and keeping them apart would emit an empty span.
    if (last && cut.startMs <= last.endMs) {
      if (cut.endMs > last.endMs) {
        merged[merged.length - 1] = { kind: "cut", startMs: last.startMs, endMs: cut.endMs };
      }
      continue;
    }
    merged.push({ kind: "cut", startMs: cut.startMs, endMs: cut.endMs });
  }
  return merged;
}

/** `true` when `ms` is strictly inside one of the merged `cuts`. */
export function insideCuts(cuts: readonly CutEdit[], ms: number): boolean {
  let low = 0;
  let high = cuts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cut = cuts[mid] as CutEdit;
    if (ms <= cut.startMs) high = mid - 1;
    else if (ms >= cut.endMs) low = mid + 1;
    else return true;
  }
  return false;
}

/** Subtracts the merged `cuts` from one speed range, yielding its surviving pieces. */
function clipSpeedByCuts(speed: SpeedEdit, cuts: readonly CutEdit[]): SpeedEdit[] {
  const pieces: SpeedEdit[] = [];
  let cursor = speed.startMs;
  for (const cut of cuts) {
    if (cut.endMs <= cursor) continue;
    if (cut.startMs >= speed.endMs) break;
    if (cut.startMs > cursor) {
      pieces.push({ kind: "speed", startMs: cursor, endMs: cut.startMs, factor: speed.factor });
    }
    cursor = Math.max(cursor, cut.endMs);
  }
  if (cursor < speed.endMs) {
    pieces.push({ kind: "speed", startMs: cursor, endMs: speed.endMs, factor: speed.factor });
  }
  return pieces;
}

/**
 * Resolves an edit list into disjoint, ordered cuts, speed ranges and holds.
 *
 * The rules, in order: cuts are clipped to the media, merged when they overlap or
 * touch, and **win** every conflict; speed ranges are clipped out of the cuts and
 * may not overlap each other; holds landing strictly inside a cut are dropped
 * because the frame they would freeze is no longer in the output.
 */
export function normaliseEdits(edits: readonly Edit[], options: NormaliseOptions): NormalisedEdits {
  const { sourceDurationMs, fps, snapCutsToFrames = false } = options;
  if (snapCutsToFrames && fps === undefined) {
    throw new TimeMapError("missing-fps", "snapCutsToFrames needs an fps to snap to");
  }
  if (fps !== undefined) assertFps(fps);

  const { cuts, speeds, holds } = partition(edits);

  const snapped =
    snapCutsToFrames && fps !== undefined
      ? cuts.map((cut) => ({
          kind: "cut" as const,
          startMs: snapToFrame(cut.startMs, fps),
          endMs: snapToFrame(cut.endMs, fps),
        }))
      : cuts;

  const mergedCuts = mergeCuts(snapped, sourceDurationMs);

  const clippedSpeeds = speeds
    .map((speed) => ({
      kind: "speed" as const,
      startMs: Math.min(speed.startMs, sourceDurationMs),
      endMs: Math.min(speed.endMs, sourceDurationMs),
      factor: speed.factor,
    }))
    .filter((speed) => speed.endMs > speed.startMs && speed.factor !== 1)
    .sort((a, b) => a.startMs - b.startMs);

  for (let i = 1; i < clippedSpeeds.length; i += 1) {
    const previous = clippedSpeeds[i - 1] as SpeedEdit;
    const current = clippedSpeeds[i] as SpeedEdit;
    if (current.startMs < previous.endMs) {
      throw new TimeMapError(
        "overlapping-speed",
        `speed ranges overlap at ${current.startMs} ms; resolve them before building the map`,
        { first: previous, second: current },
      );
    }
  }

  const resolvedSpeeds = clippedSpeeds.flatMap((speed) => clipSpeedByCuts(speed, mergedCuts));

  const survivingHolds = holds
    .map((hold) => ({
      kind: "hold" as const,
      atMs: Math.min(hold.atMs, sourceDurationMs),
      durationMs: hold.durationMs,
    }))
    .filter((hold) => hold.durationMs > 0 && !insideCuts(mergedCuts, hold.atMs))
    // Stable by construction: `sort` in V8 is stable, so equal `atMs` keeps input order.
    .sort((a, b) => a.atMs - b.atMs);

  return {
    cuts: Object.freeze(mergedCuts),
    speeds: Object.freeze(resolvedSpeeds),
    holds: Object.freeze(survivingHolds),
  };
}

/** Flattens normalised edits back into one ordered list, for serialisation. */
export function flattenEdits(edits: NormalisedEdits): Edit[] {
  const all: Edit[] = [...edits.cuts, ...edits.speeds, ...edits.holds];
  return all.sort((a, b) => {
    const aStart = a.kind === "hold" ? a.atMs : a.startMs;
    const bStart = b.kind === "hold" ? b.atMs : b.startMs;
    if (aStart !== bStart) return aStart - bStart;
    return EDIT_ORDER[a.kind] - EDIT_ORDER[b.kind];
  });
}

const EDIT_ORDER: Record<EditKind, number> = { hold: 0, cut: 1, speed: 2 };
