/**
 * Camera Punch-In Jump Cut Masking (Pillar 5 / Feature 02: Automatic Filler Word Removal).
 *
 * Implements Submagic/Descript-style visual jump cut mitigation by punching the camera in
 * (1.0x -> 1.15x -> 1.0x) on exact cut frames where disfluent segments are removed.
 */

import type { CropKeyframe } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";
import type { TimeMap, TimeSpan } from "@montaj/timemap";

import type { ProjectedWord } from "../queues.js";

export const DEFAULT_PUNCH_IN_SCALE = 1.15;

export interface PunchInOptions {
  /** Target zoom scale factor for punch-in frames. Defaults to 1.15 (1.15x). */
  readonly scale?: number;
  /** Force punch-in on all cuts regardless of whether word-level filler flags are present. */
  readonly forceAllCuts?: boolean;
}

/**
 * Checks whether a source cut interval [sourceStartMs, sourceEndMs] intersects
 * a filler or deleted word.
 */
export function isFillerCut(
  sourceStartMs: number,
  sourceEndMs: number,
  words: readonly ProjectedWord[] | undefined,
): boolean {
  if (!words || words.length === 0) return true;
  return words.some(
    (w) =>
      (w.filler === true || w.deleted === true) &&
      w.s < sourceEndMs &&
      w.e > sourceStartMs,
  );
}

/**
 * Derives normalized 0..1 crop rectangle for a given scale factor centered in the frame.
 */
export function punchInCropRect(scale: number): { x: number; y: number; w: number; h: number } {
  const s = Math.max(1.0, scale);
  if (s <= 1.0001) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  const w = Math.round((1 / s) * 10000) / 10000;
  const h = Math.round((1 / s) * 10000) / 10000;
  const x = Math.round(((1 - w) / 2) * 10000) / 10000;
  const y = Math.round(((1 - h) / 2) * 10000) / 10000;
  return { x, y, w, h };
}

/**
 * Whenever a filler cut occurs on video, toggle scale between 1.0x and 1.15x
 * on that exact cut frame to create a seamless camera punch-in.
 */
export function computeCutPunchInKeyframes(
  manifest: RenderManifest,
  timemap: TimeMap,
  words?: readonly ProjectedWord[],
  options: PunchInOptions = {},
): CropKeyframe[] {
  const targetScale = options.scale ?? DEFAULT_PUNCH_IN_SCALE;
  const bearingSpans: TimeSpan[] = timemap.spans.filter((s) => s.outputEnd > s.outputStart);

  if (bearingSpans.length <= 1) {
    return [];
  }

  // Identify cut points on the output timeline
  const cutPoints: number[] = [];
  for (let i = 0; i < bearingSpans.length - 1; i++) {
    const currentSpan = bearingSpans[i]!;
    const nextSpan = bearingSpans[i + 1]!;
    const cutStartSource = currentSpan.sourceEnd;
    const cutEndSource = nextSpan.sourceStart;

    if (cutEndSource > cutStartSource) {
      const isTargetCut =
        options.forceAllCuts === true || isFillerCut(cutStartSource, cutEndSource, words);

      if (isTargetCut) {
        cutPoints.push(currentSpan.outputEnd);
      }
    }
  }

  if (cutPoints.length === 0) {
    return [];
  }

  const rectNormal = punchInCropRect(1.0);
  const rectZoom = punchInCropRect(targetScale);

  const keyframes: CropKeyframe[] = [];
  let currentRect = rectNormal;
  let currentScale = 1.0;

  // Initial keyframe at t = 0
  keyframes.push({
    tMs: 0,
    rect: currentRect,
    easing: "linear",
  });

  for (const tCut of cutPoints) {
    const willZoom = currentScale <= 1.0001;
    const nextRect = willZoom ? rectZoom : rectNormal;
    const nextScale = willZoom ? targetScale : 1.0;

    // Hold previous scale until the instant of the cut
    if (tCut > 1) {
      keyframes.push({
        tMs: tCut - 1,
        rect: currentRect,
        easing: "linear",
      });
    }

    // Step change at the exact cut frame
    keyframes.push({
      tMs: tCut,
      rect: nextRect,
      easing: "linear",
    });

    currentRect = nextRect;
    currentScale = nextScale;
  }

  // Hold final state through the end of the video
  const durationMs = timemap.outputDurationMs;
  if (durationMs > (keyframes[keyframes.length - 1]?.tMs ?? 0)) {
    keyframes.push({
      tMs: durationMs,
      rect: currentRect,
      easing: "linear",
    });
  }

  return keyframes;
}
