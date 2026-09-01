import type { CutEdit, HoldEdit, NormalisedEdits, SpeedEdit } from "./edits.js";

/**
 * What a span does to time.
 *
 * - `retained` — source that survives; positive width on both clocks.
 * - `cut` — source that was removed; positive source width, **zero** output width.
 * - `hold` — a freeze frame; **zero** source width, positive output width.
 */
export type SpanKind = "retained" | "cut" | "hold";

/**
 * One piece of the timeline. The list returned by `buildSpans` covers
 * `[0, sourceDurationMs]` contiguously in source order and `[0, outputDurationMs]`
 * contiguously in output order, which is what makes both lookups a single search.
 */
export interface TimeSpan {
  readonly kind: SpanKind;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly outputStart: number;
  readonly outputEnd: number;
  /** Source ms per output ms. `1` at normal speed, the `SpeedEdit.factor` inside one, `1` for cuts and holds. */
  readonly factor: number;
}

/** Every source instant at which the timeline can change behaviour. */
function boundaries(edits: NormalisedEdits, sourceDurationMs: number): number[] {
  const points = new Set<number>([0, sourceDurationMs]);
  for (const cut of edits.cuts) {
    points.add(cut.startMs);
    points.add(cut.endMs);
  }
  for (const speed of edits.speeds) {
    points.add(speed.startMs);
    points.add(speed.endMs);
  }
  for (const hold of edits.holds) points.add(hold.atMs);
  return [...points].filter((ms) => ms >= 0 && ms <= sourceDurationMs).sort((a, b) => a - b);
}

/**
 * Turns normalised edits into the ordered span list.
 *
 * The walk is linear: boundary points, cuts, speed ranges and holds are all
 * ordered, so three cursors advance in step and never rescan. Output positions
 * accumulate as an exact float and are rounded only when written onto a span, so
 * neighbouring spans always agree on the boundary and the total drifts by at most
 * half a millisecond however many speed ranges there are.
 */
export function buildSpans(edits: NormalisedEdits, sourceDurationMs: number): TimeSpan[] {
  const points = boundaries(edits, sourceDurationMs);
  const { cuts, speeds, holds } = edits;

  const spans: TimeSpan[] = [];
  let exactOutput = 0;
  let outputCursor = 0;
  let cutIndex = 0;
  let speedIndex = 0;
  let holdIndex = 0;

  /** Appends a span, rounding the cumulative output position once. */
  const push = (
    kind: SpanKind,
    sourceStart: number,
    sourceEnd: number,
    exactOutputLength: number,
    factor: number,
  ): void => {
    exactOutput += exactOutputLength;
    const outputEnd = Math.round(exactOutput);
    spans.push({ kind, sourceStart, sourceEnd, outputStart: outputCursor, outputEnd, factor });
    outputCursor = outputEnd;
  };

  for (let i = 0; i < points.length; i += 1) {
    const start = points[i] as number;

    // Freeze frames land before the span that starts here, so the frame at `start`
    // is shown from the hold's output start onwards.
    while (holdIndex < holds.length && (holds[holdIndex] as HoldEdit).atMs === start) {
      push("hold", start, start, (holds[holdIndex] as HoldEdit).durationMs, 1);
      holdIndex += 1;
    }

    const end = points[i + 1];
    if (end === undefined) break;

    while (cutIndex < cuts.length && (cuts[cutIndex] as CutEdit).endMs <= start) cutIndex += 1;
    const cut = cuts[cutIndex];
    if (cut && cut.startMs <= start && end <= cut.endMs) {
      push("cut", start, end, 0, 1);
      continue;
    }

    while (speedIndex < speeds.length && (speeds[speedIndex] as SpeedEdit).endMs <= start) {
      speedIndex += 1;
    }
    const speed = speeds[speedIndex];
    const factor = speed && speed.startMs <= start && end <= speed.endMs ? speed.factor : 1;
    push("retained", start, end, (end - start) / factor, factor);
  }

  return spans;
}
