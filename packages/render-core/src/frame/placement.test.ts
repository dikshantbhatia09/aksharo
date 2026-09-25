import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";

import {
  type CanvasFaceTrack,
  facesDuring,
  type FaceTrackDocument,
  faceTrackOnCanvas,
  MIN_PLACEMENT_SCALE,
  parseFaceTrack,
  PlacementCache,
  placeCaption,
} from "./placement.js";
import { type EdgProjection } from "./projection.js";
import { layoutFrame } from "./render-frame.js";
import { type Rect } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout, type RenderSegment, type RenderWord } from "../layout/types.js";
import { createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";

const styles = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function style(id: string): StyleDoc {
  const doc = styles.get(id);
  if (doc === undefined) throw new Error(`no style ${id}`);
  return doc;
}

const SEGMENT: RenderSegment = { id: "seg", startMs: 0, endMs: 3000 };

function words(texts: readonly string[], startMs = 0, endMs = 3000): RenderWord[] {
  const span = endMs - startMs;
  return texts.map((t, index) => ({
    wid: `0:${String(index)}`,
    t,
    s: startMs + Math.round((span * index) / texts.length),
    e: startMs + Math.round((span * (index + 1)) / texts.length),
  }));
}

/** One face, still for the whole clip, normalised to a 720 x 1280 portrait source. */
function track(face: readonly number[] | undefined, source = { width: 720, height: 1280 }) {
  const doc: FaceTrackDocument = {
    version: 1,
    intervalMs: 250,
    source,
    samples: Array.from({ length: 17 }, (_, index) => [
      index * 250,
      face === undefined ? [] : [face],
    ]),
  };
  return faceTrackOnCanvas(doc, GOLDEN_CANVAS);
}

/** The face `ai.faces` found in the clip that prompted this (forehead to chin). */
const TALKING_HEAD = [0.28, 0.26, 0.63, 0.52];
const CAPTION = words(["It's", "an", "editorial", "team's", "worth", "of", "work"]);

function extent(layout: Layout): Rect {
  return layout.words.reduce<Rect>(
    (box, word) => [
      Math.min(box[0], word.box[0]),
      Math.min(box[1], word.box[1]),
      Math.max(box[2], word.box[2]),
      Math.max(box[3], word.box[3]),
    ],
    layout.paddedBox,
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function projection(segment: RenderSegment, list: readonly RenderWord[]): EdgProjection {
  return {
    canvas: GOLDEN_CANVAS,
    styles: { defaultStyleId: "punch-pop" },
    segments: [
      { ...segment, seq: "a0", startWordId: list[0]?.wid ?? "", endWordId: list.at(-1)?.wid ?? "" },
    ],
    words: list.map((word) => ({ ...word, sp: undefined })) as EdgProjection["words"],
  };
}

function frameAt(
  tMs: number,
  faces: CanvasFaceTrack | undefined,
  segment: RenderSegment = SEGMENT,
): Layout {
  const [entry] = layoutFrame({
    projection: projection(segment, CAPTION),
    timemap: null,
    catalogue: styles,
    registry,
    shaper,
    outputMs: tMs,
    ...(faces === undefined ? {} : { faces, placementCache: new PlacementCache() }),
  });
  if (entry === undefined) throw new Error("no caption on screen");
  return entry.layout;
}

describe("face track", () => {
  it("reads version 1 and ignores anything else", () => {
    expect(parseFaceTrack({ version: 2, intervalMs: 250, source: {}, samples: [] })).toBeUndefined();
    expect(parseFaceTrack(null)).toBeUndefined();
    const doc = { version: 1, intervalMs: 250, source: { width: 9, height: 16 }, samples: [] };
    expect(parseFaceTrack(doc)).toBe(doc);
  });

  it("maps a landscape source onto a portrait canvas the way a cover fit crops it", () => {
    // A 16:9 source cover-fitted into 9:16 shows only its middle 31.6% of width.
    const faces = track([0.4, 0.2, 0.2, 0.5], { width: 1920, height: 1080 });
    const [box] = faces.boxes[0] ?? [];
    // Cover-fitting scales the source by 1920/1080 so its height fills the
    // canvas; its width then spans (1920/1080)^2 canvas widths, centred.
    const spans = (1920 / 1080) ** 2;
    expect(box?.[0]).toBeCloseTo(0.5 + (0.4 - 0.5) * spans, 5);
    expect(box?.[1]).toBeCloseTo(0.2, 5);
    expect(box?.[3]).toBeCloseTo(0.7, 5);
  });

  it("drops faces too small to be the subject", () => {
    expect(track([0.1, 0.1, 0.02, 0.03]).boxes[0]).toEqual([]);
  });

  it("pads a face more above (hair) than below (chin)", () => {
    const [face] = facesDuring(track(TALKING_HEAD), 0, 1000, GOLDEN_CANVAS);
    const h = 0.52 * GOLDEN_CANVAS.height;
    expect(face?.[1]).toBeCloseTo(0.26 * GOLDEN_CANVAS.height - 0.35 * h, 0);
    expect(face?.[3]).toBeCloseTo(0.78 * GOLDEN_CANVAS.height + 0.05 * h, 0);
  });
});

describe("placeCaption", () => {
  it("moves a caption that would cover the face below it, clear at every chunk", () => {
    const faces = track(TALKING_HEAD);
    const blocked = facesDuring(faces, 0, 3000, GOLDEN_CANVAS);
    // The premise: where Punch Pop puts it, the caption covers the face.
    expect(blocked.some((face) => overlaps(face, extent(frameAt(100, undefined))))).toBe(true);

    for (const tMs of CAPTION.map((word) => word.s + 10)) {
      const placed = extent(frameAt(tMs, faces));
      for (const face of blocked) expect(overlaps(face, placed)).toBe(false);
      expect(placed[1]).toBeGreaterThanOrEqual(Math.max(...blocked.map((face) => face[3])) - 0.5);
      expect(placed[3]).toBeLessThanOrEqual(GOLDEN_CANVAS.height);
    }
  });

  it("keeps one position for the caption's whole life", () => {
    const faces = track(TALKING_HEAD);
    const first = frameAt(10, faces);
    const later = frameAt(2900, faces);
    expect(later.paddedBox[3]).toBeCloseTo(first.paddedBox[3], 0);
  });

  it("leaves a caption alone when no face is near it", () => {
    expect(
      placeCaption({
        style: style("punch-pop"),
        segment: SEGMENT,
        words: CAPTION,
        canvas: GOLDEN_CANVAS,
        registry,
        shaper,
        faces: track([0.35, 0.05, 0.3, 0.2]),
      }),
    ).toBeUndefined();
    expect(frameAt(100, track(undefined)).paddedBox).toEqual(frameAt(100, undefined).paddedBox);
  });

  it("never moves a caption the user placed", () => {
    const pinned = { ...SEGMENT, position: { x: 0.5, y: 0.5, anchor: "middle-center" } };
    expect(
      placeCaption({
        style: style("punch-pop"),
        segment: pinned,
        words: CAPTION,
        canvas: GOLDEN_CANVAS,
        registry,
        shaper,
        faces: track(TALKING_HEAD),
      }),
    ).toBeUndefined();
  });

  it("shrinks a caption to fit when the face fills most of the frame", () => {
    const placement = placeCaption({
      style: style("punch-pop"),
      segment: SEGMENT,
      words: CAPTION,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      faces: track([0.1, 0.12, 0.8, 0.66]),
    });
    expect(placement?.shrink).toBeDefined();
    expect(placement?.shrink ?? 1).toBeLessThan(1);
    expect(placement?.shrink ?? 0).toBeGreaterThanOrEqual(MIN_PLACEMENT_SCALE * 0.55 - 1e-9);
  });

  it("draws the same caption the same way with or without a cache", () => {
    const faces = track(TALKING_HEAD);
    const cached = frameAt(1200, faces);
    const [uncached] = layoutFrame({
      projection: projection(SEGMENT, CAPTION),
      timemap: null,
      catalogue: styles,
      registry,
      shaper,
      outputMs: 1200,
      faces,
    });
    expect(uncached?.layout.paddedBox).toEqual(cached.paddedBox);
    // And it is a real layout, not a guess: it matches laying out at that position.
    expect(
      layoutSegment({
        style: style("punch-pop"),
        segment: SEGMENT,
        words: CAPTION,
        canvas: GOLDEN_CANVAS,
        registry,
        shaper,
        tMs: 1200,
      }).paddedBox,
    ).not.toEqual(cached.paddedBox);
  });
});
