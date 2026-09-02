/**
 * The timeline's "output-time mode" (brief §6): when accepted cuts exist, the
 * captions and the ruler can show output time (the edited timeline the
 * viewer sees) instead of source time (the proxy's own clock), via
 * `@montaj/timemap`. Pure functions only, so the playhead math is
 * unit-testable without mounting anything.
 *
 * The proxy `<video>` element `CaptionStage` owns always plays source time —
 * there is no edited-output proxy render in this work package — so
 * scrubbing always maps an on-screen (possibly output-mode) position back to
 * source time before it reaches playback, per the brief: "scrubbing maps
 * back to source time for the proxy video".
 */
import type { TimeMap } from "@montaj/timemap";

export type TimeDisplayMode = "source" | "output";

/**
 * The ms value the ruler/playhead should be drawn at for `sourceMs`, in the
 * given mode. In output mode, a `sourceMs` inside a cut has no output
 * position (`toOutput` is `null`) — the nearest splice is used, i.e. the cut
 * collapses to a single point on the output ruler, which is exactly what the
 * viewer sees.
 */
export function toDisplayMs(sourceMs: number, mode: TimeDisplayMode, timeMap: TimeMap | undefined): number {
  if (mode === "source" || timeMap === undefined) return sourceMs;
  const output = timeMap.toOutput(sourceMs);
  if (output !== null) return output;
  return timeMap.locateSource(sourceMs).outputMs;
}

/**
 * The source ms a scrub/click at `displayMs` (in `mode`) corresponds to —
 * always what the proxy `<video>` should seek to, per the brief.
 */
export function toSourceMs(displayMs: number, mode: TimeDisplayMode, timeMap: TimeMap | undefined): number {
  if (mode === "source" || timeMap === undefined) return displayMs;
  return timeMap.toSource(displayMs);
}

/** The display-clock duration: `outputDurationMs` in output mode, `sourceDurationMs` otherwise. */
export function displayDurationMs(
  sourceDurationMs: number,
  mode: TimeDisplayMode,
  timeMap: TimeMap | undefined,
): number {
  if (mode === "source" || timeMap === undefined) return sourceDurationMs;
  return timeMap.outputDurationMs;
}

/** `true` when `sourceMs` sits inside a cut removed by `timeMap` — used to draw the ghosted source ruler / hatching. */
export function isCutAway(sourceMs: number, timeMap: TimeMap | undefined): boolean {
  if (timeMap === undefined) return false;
  return timeMap.isInsideCut(sourceMs);
}

/** Whether output mode is even offered: only once at least one cut is accepted (brief: "when accepted cuts exist"). */
export function outputModeAvailable(timeMap: TimeMap | undefined): boolean {
  return timeMap !== undefined && timeMap.cuts.length > 0;
}
