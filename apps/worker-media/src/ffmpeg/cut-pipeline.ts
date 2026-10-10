/**
 * FFmpeg Cross-Fade Audio Cut Pipeline (Pillar 5 / Feature 02: Automatic Filler Word Removal).
 *
 * Implements 15ms equal-power acoustic cross-fading (`acrossfade=d=0.015:c1=tri:c2=tri`)
 * across sliced disfluent intervals to eliminate DC offset, audio clicks, and micro-pops.
 */

export interface TimeInterval {
  readonly startSec: number;
  readonly endSec: number;
}

export interface AudioCrossfadeOptions {
  /** Crossfade duration in seconds. Defaults to 0.015 (15ms equal-power). */
  readonly crossfadeDurationSec?: number;
  /** Audio fade-out curve (acrossfade c1). Defaults to 'tri' (triangular / equal-power). */
  readonly curve1?: string;
  /** Audio fade-in curve (acrossfade c2). Defaults to 'tri' (triangular / equal-power). */
  readonly curve2?: string;
  /** Input audio stream label. Defaults to '0:a'. */
  readonly inputLabel?: string;
  /** Output audio stream label. Defaults to 'aout'. */
  readonly outputLabel?: string;
}

export interface CutPipelineResult {
  readonly filtergraph: string;
  readonly outputAudioLabel: string;
  readonly retainedSegments: readonly TimeInterval[];
  readonly totalRemovedSec: number;
  readonly effectiveDurationSec: number;
}

/** Format seconds to 3 decimal places without unnecessary scientific notation. */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return "0";
  return Math.max(0, sec).toFixed(3);
}

/**
 * Merge overlapping and adjacent cut intervals, bounded by [0, totalDurationSec].
 */
export function normalizeCutIntervals(
  cutIntervals: readonly TimeInterval[],
  totalDurationSec: number,
): TimeInterval[] {
  if (cutIntervals.length === 0 || totalDurationSec <= 0) return [];

  const bounded = cutIntervals
    .map((c) => ({
      startSec: Math.max(0, Math.min(totalDurationSec, c.startSec)),
      endSec: Math.max(0, Math.min(totalDurationSec, c.endSec)),
    }))
    .filter((c) => c.endSec > c.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  if (bounded.length === 0) return [];

  const merged: TimeInterval[] = [bounded[0]!];
  for (let i = 1; i < bounded.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = bounded[i]!;
    if (curr.startSec <= prev.endSec) {
      merged[merged.length - 1] = {
        startSec: prev.startSec,
        endSec: Math.max(prev.endSec, curr.endSec),
      };
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Derives retained segments [startSec, endSec] by inverting the cut intervals over totalDurationSec.
 */
export function retainedIntervalsFromCuts(
  cutIntervals: readonly TimeInterval[],
  totalDurationSec: number,
): TimeInterval[] {
  if (totalDurationSec <= 0) return [];
  const normalizedCuts = normalizeCutIntervals(cutIntervals, totalDurationSec);

  if (normalizedCuts.length === 0) {
    return [{ startSec: 0, endSec: totalDurationSec }];
  }

  const retained: TimeInterval[] = [];
  let cursor = 0;

  for (const cut of normalizedCuts) {
    if (cut.startSec > cursor) {
      retained.push({ startSec: cursor, endSec: cut.startSec });
    }
    cursor = Math.max(cursor, cut.endSec);
  }

  if (cursor < totalDurationSec) {
    retained.push({ startSec: cursor, endSec: totalDurationSec });
  }

  return retained;
}

/**
 * Synthesizes an FFmpeg audio crossfade filtergraph for a sequence of retained intervals.
 *
 * For two segments (1 cut):
 *   [0:a]atrim=0:t1,asetpts=PTS-STARTPTS[a1]; \
 *   [0:a]atrim=t2:duration,asetpts=PTS-STARTPTS[a2]; \
 *   [a1][a2]acrossfade=d=0.015:c1=tri:c2=tri[aout]
 *
 * For N segments (N - 1 cuts):
 *   Chains acrossfade filters pairwise so every spliced boundary is smoothly blended without clicks.
 */
export function buildAudioCrossfadeFiltergraph(
  retainedSegments: readonly TimeInterval[],
  options: AudioCrossfadeOptions = {},
): string {
  if (retainedSegments.length === 0) return "";

  const inputLabel = options.inputLabel ?? "0:a";
  const outputLabel = options.outputLabel ?? "aout";
  const crossfadeD = options.crossfadeDurationSec ?? 0.015;
  const curve1 = options.curve1 ?? "tri";
  const curve2 = options.curve2 ?? "tri";

  if (retainedSegments.length === 1) {
    const s0 = formatSeconds(retainedSegments[0]!.startSec);
    const e0 = formatSeconds(retainedSegments[0]!.endSec);
    return `[${inputLabel}]atrim=start=${s0}:end=${e0},asetpts=PTS-STARTPTS[${outputLabel}]`;
  }

  const filterParts: string[] = [];

  // 1. Trim each retained audio chunk
  for (let i = 0; i < retainedSegments.length; i++) {
    const s = formatSeconds(retainedSegments[i]!.startSec);
    const e = formatSeconds(retainedSegments[i]!.endSec);
    const label = `a${String(i + 1)}`;
    filterParts.push(
      `[${inputLabel}]atrim=${s}:${e},asetpts=PTS-STARTPTS[${label}]`,
    );
  }

  // 2. Chain equal-power acrossfade between adjacent chunks
  if (retainedSegments.length === 2) {
    filterParts.push(
      `[a1][a2]acrossfade=d=${String(crossfadeD)}:c1=${curve1}:c2=${curve2}[${outputLabel}]`,
    );
  } else {
    filterParts.push(
      `[a1][a2]acrossfade=d=${String(crossfadeD)}:c1=${curve1}:c2=${curve2}[ax1]`,
    );
    for (let i = 2; i < retainedSegments.length - 1; i++) {
      const prevX = `ax${String(i - 1)}`;
      const nextA = `a${String(i + 1)}`;
      const nextX = `ax${String(i)}`;
      filterParts.push(
        `[${prevX}][${nextA}]acrossfade=d=${String(crossfadeD)}:c1=${curve1}:c2=${curve2}[${nextX}]`,
      );
    }
    const lastPrevX = `ax${String(retainedSegments.length - 2)}`;
    const lastA = `a${String(retainedSegments.length)}`;
    filterParts.push(
      `[${lastPrevX}][${lastA}]acrossfade=d=${String(crossfadeD)}:c1=${curve1}:c2=${curve2}[${outputLabel}]`,
    );
  }

  return filterParts.join("; ");
}

/**
 * Builds the complete crossfade cut result from cut intervals and total media duration.
 */
export function buildCutCrossfadeFiltergraph(
  cutIntervals: readonly TimeInterval[],
  totalDurationSec: number,
  options: AudioCrossfadeOptions = {},
): CutPipelineResult {
  const retainedSegments = retainedIntervalsFromCuts(cutIntervals, totalDurationSec);
  const filtergraph = buildAudioCrossfadeFiltergraph(retainedSegments, options);
  const outputAudioLabel = options.outputLabel ?? "aout";

  const totalRetainedSec = retainedSegments.reduce(
    (sum, seg) => sum + (seg.endSec - seg.startSec),
    0,
  );
  const totalRemovedSec = Math.max(0, totalDurationSec - totalRetainedSec);

  return {
    filtergraph,
    outputAudioLabel,
    retainedSegments,
    totalRemovedSec,
    effectiveDurationSec: totalRetainedSec,
  };
}

/**
 * Synthesizes full FFmpeg CLI arguments to splice audio (and optional video) with crossfade.
 */
export function buildCrossfadeCutCommand(
  inputSource: string,
  outputPath: string,
  cutIntervals: readonly TimeInterval[],
  totalDurationSec: number,
  options: AudioCrossfadeOptions & {
    readonly hasVideo?: boolean;
    readonly videoFilter?: string;
  } = {},
): string[] {
  const pipeline = buildCutCrossfadeFiltergraph(cutIntervals, totalDurationSec, options);
  const args: string[] = ["-y", "-i", inputSource];

  if (!pipeline.filtergraph) {
    return [...args, "-c", "copy", outputPath];
  }

  const filters: string[] = [pipeline.filtergraph];

  if (options.hasVideo) {
    // For video cuts, stitch retained segments with concat filter
    const videoParts: string[] = [];
    const vLabels: string[] = [];
    for (let i = 0; i < pipeline.retainedSegments.length; i++) {
      const seg = pipeline.retainedSegments[i]!;
      const s = formatSeconds(seg.startSec);
      const e = formatSeconds(seg.endSec);
      const vLabel = `v${String(i + 1)}`;
      videoParts.push(`[0:v]trim=${s}:${e},setpts=PTS-STARTPTS[${vLabel}]`);
      vLabels.push(`[${vLabel}]`);
    }
    const concatV = `${vLabels.join("")}concat=n=${String(vLabels.length)}:v=1:a=0[vout]`;
    filters.push(...videoParts, concatV);

    args.push(
      "-filter_complex",
      filters.join("; "),
      "-map",
      "[vout]",
      "-map",
      `[${pipeline.outputAudioLabel}]`,
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    );
  } else {
    args.push(
      "-filter_complex",
      filters.join("; "),
      "-map",
      `[${pipeline.outputAudioLabel}]`,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    );
  }

  return args;
}
