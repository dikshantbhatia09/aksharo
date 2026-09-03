/**
 * B20b's crop-window parity fixtures — the same two curves
 * `../src/ffmpeg/crop-parity.test.ts` checks browser (`sampleCropWindow`) and
 * cloud (`buildDynamicCropFilter`) agree on, pulled out into their own module
 * so this directory's `run.ts` can measure and record numbers for them
 * without duplicating the curves inline. Kept in `parity/` rather than
 * imported from the test file, which is outside this work package's file
 * boundary (`apps/render/src/ffmpeg/**`) — see B20b's final report.
 */
import type { CropKeyframe } from "@montaj/render-core";

export interface CropFixture {
  readonly id: string;
  readonly label: string;
  readonly keyframes: readonly CropKeyframe[];
  /** Output seconds to sample and compare — matches the source test's own walk. */
  readonly sampleAtSec: readonly number[];
}

export const SOURCE_WIDTH = 1080;
export const SOURCE_HEIGHT = 1920;

export const CROP_PARITY_FIXTURES: readonly CropFixture[] = [
  {
    id: "cut-plus-zoom",
    label: "A cut plus a zoom-in",
    keyframes: [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, easing: "linear" },
      { tMs: 1_000, rect: { x: 0.3, y: 0.35, w: 0.4, h: 0.4 } },
    ],
    sampleAtSec: [0, 0.25, 0.5, 0.75, 1, 2],
  },
  {
    id: "cut-plus-reframe",
    label: "A cut plus a reframe sweep",
    keyframes: [
      { tMs: 0, rect: { x: 0, y: 0.1, w: 0.5, h: 0.8 }, easing: "linear" },
      { tMs: 1_500, rect: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 }, easing: "linear" },
      { tMs: 3_000, rect: { x: 0.5, y: 0.1, w: 0.5, h: 0.8 } },
    ],
    sampleAtSec: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4],
  },
];
