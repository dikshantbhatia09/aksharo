import { beforeAll, describe, expect, it } from "vitest";

import { PICKABLE_STYLE_IDS, loadSystemStyleMap } from "@montaj/caption-styles";

import {
  type CanvasFaceTrack,
  type FaceTrackDocument,
  facesDuring,
  faceTrackOnCanvas,
  PlacementCache,
  placeCaption,
} from "./placement.js";
import { type EdgProjection } from "./projection.js";
import { layoutFrame } from "./render-frame.js";
import { type Rect } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type Layout, type RenderSegment, type RenderWord } from "../layout/types.js";
import { layoutHookTitle } from "../overlay/hook-title.js";
import { createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";

/**
 * Two-speaker layouts (2026-10-01): a podcast clip can be cut with each of two
 * people in half of the picture, one above the other (worker-media
 * `stackedFrame`: each face on the upper third line of its half, a head and
 * shoulders tall). Its captions are placed by the same rules as any clip's,
 * from the clip's own face track, which then holds two faces one above the
 * other. This checks that every caption style a person can pick lands clear of
 * both faces on such a picture - between them or below them - at every word,
 * for the face sizes and rows a stacked cut produces.
 */

const styles = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

const SEGMENT: RenderSegment = { id: "seg", startMs: 0, endMs: 3000 };

/** A Hinglish line of the length a podcast caption usually is. */
const WORDS: RenderWord[] = [
  "Yeh",
  "podcast",
  "mein",
  "dono",
  "log",
  "ek",
  "saath",
  "baat",
  "karte",
  "hain",
].map((t, index, all) => ({
  wid: `0:${String(index)}`,
  t,
  s: Math.round((3000 * index) / all.length),
  e: Math.round((3000 * (index + 1)) / all.length),
}));

/**
 * A stacked 9:16 clip's face track: in each 1080 x 960 half, a face `share` of
 * the half tall (a face box ~0.85 as wide as tall), centred across, on `rows`
 * (the face's centre, as a share of its half's height, top half first).
 */
function stackedTrack(share: number, rows: readonly [number, number]): CanvasFaceTrack {
  const halfHeight = 0.5;
  const height = share * halfHeight;
  const width = (share * 960 * 0.85) / 1080;
  const boxes = rows.map((row, index) => [
    0.5 - width / 2,
    (index + row) * halfHeight - height / 2,
    width,
    height,
  ]);
  const doc: FaceTrackDocument = {
    version: 1,
    intervalMs: 250,
    // The clip's 540p proxy, which `ai.faces` reads: the canvas's own shape.
    source: { width: 540, height: 960 },
    samples: Array.from({ length: 17 }, (_, index) => [index * 250, boxes]),
  };
  return faceTrackOnCanvas(doc, GOLDEN_CANVAS);
}

function projection(styleId: string): EdgProjection {
  return {
    canvas: GOLDEN_CANVAS,
    styles: { defaultStyleId: styleId },
    segments: [
      {
        ...SEGMENT,
        seq: "a0",
        startWordId: WORDS[0]?.wid ?? "",
        endWordId: WORDS.at(-1)?.wid ?? "",
      },
    ],
    words: WORDS.map((word) => ({ ...word, sp: undefined })) as EdgProjection["words"],
  };
}

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

/** The two faces themselves, in canvas pixels: what a caption must never cover. */
function faceBoxes(track: CanvasFaceTrack): Rect[] {
  return (track.boxes[0] ?? []).map(([left, top, right, bottom]) => [
    left * GOLDEN_CANVAS.width,
    top * GOLDEN_CANVAS.height,
    right * GOLDEN_CANVAS.width,
    bottom * GOLDEN_CANVAS.height,
  ]);
}

/**
 * The stacked pictures a cut makes: the nominal framing (a fifth of the half,
 * upper third), a small face (the window is never cut tighter than half the
 * source's height), a large one (a close-up, held back by the other person's
 * side of the frame), and faces pushed off the third line where the window met
 * the top or the bottom of the source.
 */
const PICTURES: readonly (readonly [string, number, readonly [number, number]])[] = [
  ["nominal", 0.22, [1 / 3, 1 / 3]],
  ["small faces", 0.13, [1 / 3, 1 / 3]],
  ["large faces", 0.4, [1 / 3, 1 / 3]],
  ["clamped at the frame's edges", 0.22, [0.2, 0.5]],
];

describe("caption placement on a stacked two-speaker clip", () => {
  it.each(PICKABLE_STYLE_IDS.flatMap((id) => PICTURES.map((picture) => [id, ...picture] as const)))(
    "%s keeps clear of both faces (%s)",
    (styleId, _name, share, rows) => {
      const faces = stackedTrack(share, rows);
      const boxes = faceBoxes(faces);
      expect(boxes).toHaveLength(2);
      const cache = new PlacementCache();
      for (const word of WORDS) {
        const [entry] = layoutFrame({
          projection: projection(styleId),
          timemap: null,
          catalogue: styles,
          registry,
          shaper,
          outputMs: word.s + 10,
          faces,
          placementCache: cache,
        });
        if (entry === undefined) continue;
        const placed = extent(entry.layout);
        for (const face of boxes)
          expect(overlaps(face, placed), `${styleId} at ${word.t}`).toBe(false);
        // And on the canvas.
        expect(placed[1]).toBeGreaterThanOrEqual(0);
        expect(placed[3]).toBeLessThanOrEqual(GOLDEN_CANVAS.height);
      }
    },
  );
});

describe("where a caption goes on a stacked picture", () => {
  const placeOn = (styleId: string, faces: CanvasFaceTrack) => {
    const style = styles.get(styleId);
    if (style === undefined) throw new Error(`no style ${styleId}`);
    return placeCaption({
      style,
      segment: SEGMENT,
      words: WORDS,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      faces,
    });
  };
  const at = (styleId: string, faces: CanvasFaceTrack, tMs = 10): Rect => {
    const [entry] = layoutFrame({
      projection: projection(styleId),
      timemap: null,
      catalogue: styles,
      registry,
      shaper,
      outputMs: tMs,
      faces,
      placementCache: new PlacementCache(),
    });
    if (entry === undefined) throw new Error("no caption on screen");
    return extent(entry.layout);
  };

  it("goes below both faces when it fits there, as on any clip", () => {
    const faces = stackedTrack(0.22, [1 / 3, 1 / 3]);
    const placement = placeOn("punch-pop", faces);
    expect(placement?.shrink).toBeUndefined();
    const lowest = Math.max(...facesDuring(faces, 0, 3000, GOLDEN_CANVAS).map((face) => face[3]));
    expect(at("punch-pop", faces)[1]).toBeGreaterThanOrEqual(lowest);
  });

  it("goes between the faces, at full size, when neither below nor above holds it", () => {
    // The lower face sits low in its half (its window met the frame's edge):
    // a three-line boxed caption has no room under it, even shrunk, and used
    // to be pushed back over it by the safe area.
    const faces = stackedTrack(0.22, [0.2, 0.5]);
    const placement = placeOn("karaoke-fill", faces);
    expect(placement?.shrink).toBeUndefined();
    const [upper, lower] = facesDuring(faces, 0, 250, GOLDEN_CANVAS);
    const placed = at("karaoke-fill", faces);
    expect(placed[1]).toBeGreaterThanOrEqual(upper?.[3] ?? Number.POSITIVE_INFINITY);
    expect(placed[3]).toBeLessThanOrEqual(lower?.[1] ?? 0);
  });
});

describe("the hook title on a stacked two-speaker clip", () => {
  it.each(PICKABLE_STYLE_IDS.flatMap((id) => PICTURES.map((picture) => [id, ...picture] as const)))(
    "%s keeps its hook title clear of both faces (%s)",
    (styleId, _name, share, rows) => {
      const style = styles.get(styleId);
      if (style === undefined) throw new Error(`no style ${styleId}`);
      const faces = stackedTrack(share, rows);
      const title = layoutHookTitle({
        overlay: {
          id: "01JHOOK0000000000000000000",
          kind: "hook-title",
          text: "Dono ne ek hi galti ki",
          startMs: 0,
          endMs: 2_500,
        },
        style,
        canvas: GOLDEN_CANVAS,
        registry,
        shaper,
        faces,
      });
      expect(title).toBeDefined();
      if (title === undefined) return;
      for (const face of faceBoxes(faces)) expect(overlaps(face, title.card)).toBe(false);
    },
  );
});
