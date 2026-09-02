/**
 * Timing-nudge signal (brief: "consistent user drag deltas are emitted as a
 * timing-nudge signal for B09"). The interface plus this no-op sink, exactly
 * the brief's wording, wired at the one place drag deltas are produced
 * (`resolveSegmentDrag` in `snapping.ts`, called from `Timeline.tsx`) so a
 * real sink was always a constructor argument, not a call-site change — and
 * B09b is that real sink: `memory-nudge-sink.ts`'s `createMemoryNudgeSink`,
 * consent-gated and debounced per drag, `POST`ing to
 * `/memory/hooks/timing-nudge`. `noopNudgeSink` stays the shared identity
 * `Timeline.tsx` checks against to decide whether a caller passed its own
 * sink or wants the real one (its doc-comment on `resolvedNudgeSink`).
 */

export type TimingNudgeKind =
  "segment-start" | "segment-end" | "word-start" | "word-end" | "word-select" | "playhead-scrub";

export interface TimingNudge {
  readonly kind: TimingNudgeKind;
  readonly targetId: string;
  /** Signed delta, ms: positive is later, negative is earlier. */
  readonly deltaMs: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly atEpochMs: number;
}

export interface TimingNudgeSink {
  record(nudge: TimingNudge): void;
}

/** The default sink until B09 exists. Never throws, never stores anything. */
export const noopNudgeSink: TimingNudgeSink = {
  record(): void {
    // intentionally empty
  },
};

/** Builds the nudge for a resolved segment-edge drag, ready for a sink. */
export function segmentEdgeNudge(
  edge: "start" | "end",
  segmentId: string,
  fromMs: number,
  toMs: number,
  now: () => number = Date.now,
): TimingNudge {
  return {
    kind: edge === "start" ? "segment-start" : "segment-end",
    targetId: segmentId,
    deltaMs: toMs - fromMs,
    fromMs,
    toMs,
    atEpochMs: now(),
  };
}

/**
 * Builds the nudge for a resolved word-edge drag (A02d), ready for a sink —
 * mirrors {@link segmentEdgeNudge} exactly, at the word grain `SetWordTiming`
 * writes rather than the segment grain `SetSegmentBounds` writes.
 */
export function wordEdgeNudge(
  edge: "start" | "end",
  wordId: string,
  fromMs: number,
  toMs: number,
  now: () => number = Date.now,
): TimingNudge {
  return {
    kind: edge === "start" ? "word-start" : "word-end",
    targetId: wordId,
    deltaMs: toMs - fromMs,
    fromMs,
    toMs,
    atEpochMs: now(),
  };
}
