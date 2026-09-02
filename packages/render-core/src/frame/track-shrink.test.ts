import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";

import { hashCommands } from "../commands/hash.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";
import { type EdgProjection, type ProjectedSegment } from "./projection.js";
import { layoutFrame, renderFrame } from "./render-frame.js";
import { type TranscriptWord } from "./resolve.js";
import { computeTrackShrink, trackShrinkFor, trackShrinkKey } from "./track-shrink.js";

/**
 * Track-level shrink exists to stop the type size jittering shot to shot: with
 * per-caption shrink a short caption is drawn at full size and a longer one
 * smaller, inside the same video.
 */

const catalogue = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

/**
 * Three captions of very different lengths, so per-caption shrink would give
 * three different sizes.
 */
const WORDS: TranscriptWord[] = [
  { wid: "0:0", s: 0, e: 500, t: "Hi" },
  { wid: "0:1", s: 500, e: 1000, t: "there" },
  { wid: "0:2", s: 1000, e: 1500, t: "transcription" },
  { wid: "0:3", s: 1500, e: 2000, t: "and" },
  { wid: "0:4", s: 2000, e: 2500, t: "editing" },
  { wid: "0:5", s: 2500, e: 3000, t: "brother" },
  { wid: "0:6", s: 3000, e: 3500, t: "today" },
  { wid: "0:7", s: 3500, e: 4000, t: "we" },
  { wid: "0:8", s: 4000, e: 4500, t: "will" },
  { wid: "0:9", s: 4500, e: 5000, t: "learn" },
];

const SEGMENTS: ProjectedSegment[] = [
  { id: "short", seq: "V", startWordId: "0:0", endWordId: "0:1", startMs: 0, endMs: 1000 },
  { id: "long", seq: "l", startWordId: "0:2", endWordId: "0:6", startMs: 1000, endMs: 3500 },
  { id: "medium", seq: "t", startWordId: "0:7", endWordId: "0:9", startMs: 3500, endMs: 5000 },
];

function projection(overrides: Partial<EdgProjection> = {}): EdgProjection {
  return {
    canvas: GOLDEN_CANVAS,
    styles: { defaultStyleId: "hype-bold" },
    segments: SEGMENTS,
    words: WORDS,
    ...overrides,
  };
}

function options(extra: Partial<Parameters<typeof layoutFrame>[0]> = {}) {
  return {
    projection: projection(),
    timemap: null,
    catalogue,
    registry,
    shaper,
    outputMs: 0,
    ...extra,
  } as Parameters<typeof layoutFrame>[0];
}

/** The size each caption is actually drawn at, keyed by segment id. */
function sizesAt(trackShrink?: ReturnType<typeof computeTrackShrink>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const segment of SEGMENTS) {
    const at = segment.startMs + (segment.endMs - segment.startMs) / 2;
    const frame = layoutFrame(
      options({ outputMs: at, ...(trackShrink === undefined ? {} : { trackShrink }) }),
    );
    for (const entry of frame) sizes.set(entry.layout.segmentId, entry.layout.fontSizePx);
  }
  return sizes;
}

describe("computeTrackShrink", () => {
  it("returns the minimum shrink per style and script", () => {
    const map = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    expect(map.size).toBe(1);
    const key = trackShrinkKey("hype-bold", "latin");
    expect([...map.keys()]).toEqual([key]);
    const value = map.get(key);
    expect(value).toBeDefined();
    expect(value ?? 1).toBeGreaterThan(0);
    expect(value ?? 1).toBeLessThanOrEqual(1);
  });

  it("keys separately per script, because a Hinglish project sizes them differently", () => {
    const mixed: TranscriptWord[] = [
      { wid: "1:0", s: 0, e: 500, t: "hello" },
      { wid: "1:1", s: 500, e: 1000, t: "there" },
      { wid: "1:2", s: 1000, e: 1500, t: "ट्रांसक्रिप्ट" },
      { wid: "1:3", s: 1500, e: 2000, t: "मुश्किल" },
    ];
    const map = computeTrackShrink({
      projection: projection({
        words: mixed,
        segments: [
          { id: "a", seq: "V", startWordId: "1:0", endWordId: "1:1", startMs: 0, endMs: 1000 },
          { id: "b", seq: "l", startWordId: "1:2", endWordId: "1:3", startMs: 1000, endMs: 2000 },
        ],
      }),
      catalogue,
      registry,
      shaper,
    });
    expect([...map.keys()].sort()).toEqual([
      trackShrinkKey("hype-bold", "devanagari"),
      trackShrinkKey("hype-bold", "latin"),
    ]);
  });

  it("is a pure function: same inputs, same map, every time", () => {
    const once = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
      expect([...again.entries()].sort()).toEqual([...once.entries()].sort());
    }
  });

  it("does not depend on the order the segments arrive in", () => {
    const forward = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    const reversed = computeTrackShrink({
      projection: projection({ segments: [...SEGMENTS].reverse() }),
      catalogue,
      registry,
      shaper,
    });
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  it("skips hidden captions and captions whose words are gone", () => {
    const empty = computeTrackShrink({
      projection: projection({
        segments: [{ ...SEGMENTS[0], hidden: true } as ProjectedSegment],
      }),
      catalogue,
      registry,
      shaper,
    });
    expect(empty.size).toBe(0);

    const noWords = computeTrackShrink({
      projection: projection({
        segments: [{ ...SEGMENTS[0], startWordId: "9:9", endWordId: "9:9" } as ProjectedSegment],
      }),
      catalogue,
      registry,
      shaper,
    });
    expect(noWords.size).toBe(0);
  });

  it("measures at the canvas it is given, so a proxy preview agrees with the master", () => {
    const master = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    const proxy = computeTrackShrink({
      projection: projection(),
      catalogue,
      registry,
      shaper,
      canvas: { width: 540, height: 960 },
    });
    // Sizes are relative, so halving the canvas must not change the shrink.
    expect([...proxy.entries()].sort()).toEqual([...master.entries()].sort());
  });

  it("looks an entry up by style and script, and answers undefined for anything else", () => {
    const map = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    expect(trackShrinkFor(map, "hype-bold", "latin")).toBeDefined();
    expect(trackShrinkFor(map, "hype-bold", "tamil")).toBeUndefined();
    expect(trackShrinkFor(map, "punch-pop", "latin")).toBeUndefined();
    expect(trackShrinkFor(undefined, "hype-bold", "latin")).toBeUndefined();
  });
});

describe("applying the track shrink", () => {
  it("draws every caption at one size, where per-caption shrink would not", () => {
    const perCaption = sizesAt();
    expect(perCaption.size).toBe(3);
    // The captions differ in length, so left alone they differ in size.
    expect(new Set(perCaption.values()).size).toBeGreaterThan(1);

    const map = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    const uniform = sizesAt(map);
    expect(uniform.size).toBe(3);
    expect(new Set(uniform.values()).size).toBe(1);
  });

  it("uses the smallest size the track needs, never a larger one", () => {
    const perCaption = [...sizesAt().values()];
    const uniform = [
      ...sizesAt(
        computeTrackShrink({ projection: projection(), catalogue, registry, shaper }),
      ).values(),
    ];
    // The map stores the shrink quantised to three decimals, so the uniform size
    // lands on or a hair under the tightest caption's — never above it.
    expect(Math.max(...uniform)).toBeLessThanOrEqual(Math.min(...perCaption));
    expect(Math.max(...uniform)).toBeCloseTo(Math.min(...perCaption), 1);
  });

  it("is ignored when the map has nothing to say about a style", () => {
    const foreign = new Map([[trackShrinkKey("punch-pop", "latin"), 0.6]]);
    expect([...sizesAt(foreign).values()]).toEqual([...sizesAt().values()]);
  });

  it("never lets a looser override make a caption overflow", () => {
    // 1 is looser than what the long caption needs; `min(own, override)` wins.
    const loose = new Map([[trackShrinkKey("hype-bold", "latin"), 1]]);
    expect([...sizesAt(loose).values()]).toEqual([...sizesAt().values()]);
  });

  it("produces deterministic frames", () => {
    const map = computeTrackShrink({ projection: projection(), catalogue, registry, shaper });
    const frame = (): string =>
      hashCommands(renderFrame(options({ outputMs: 2000, trackShrink: map })));
    const first = frame();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(frame()).toBe(first);
    expect(first).not.toBe(hashCommands(renderFrame(options({ outputMs: 2000 }))));
  });
});
