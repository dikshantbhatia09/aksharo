/**
 * B-roll cutaways (2026-10-05): placed, moved and faded on their own, and
 * drawn under everything else inside `renderFrame`.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { BROLL_RULES } from "@montaj/edg";

import { hashCommands } from "../commands/hash.js";
import { type DrawCommand, type Rect, walkCommands } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type CanvasFaceTrack } from "../frame/placement.js";
import { type EdgProjection } from "../frame/projection.js";
import { renderFrame } from "../frame/render-frame.js";
import { createFixtureRenderer } from "../testing.js";
import {
  BROLL_FADE_MS,
  BROLL_PAN_TRAVEL,
  BROLL_ZOOM,
  brollOpacity,
  brollPictureRect,
  drawBRoll,
  layoutBRoll,
  PIP_WIDTH,
  pipRect,
} from "./b-roll.js";
import { type BRollTrack, type HookTitleTrack, type LogoTrack, overlayImageIds } from "./types.js";

const catalogue = loadSystemStyleMap();
const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

const CUTAWAY: BRollTrack = {
  id: "01JBR0000000000000000000C1",
  kind: "b-roll",
  startMs: 4_000,
  endMs: 7_000,
  // A 2:3 portrait photo, the shape a stock search for a vertical clip returns.
  image: { assetId: "01JPX0000000000000000000C1", format: "jpeg", width: 1200, height: 1800 },
  mode: "full",
  motion: "push-in",
};

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

const width = (rect: Rect) => rect[2] - rect[0];
const height = (rect: Rect) => rect[3] - rect[1];
const centreX = (rect: Rect) => (rect[0] + rect[2]) / 2;

describe("the fade", () => {
  it("is the one @montaj/edg places cutaways by", () => {
    expect(BROLL_FADE_MS).toBe(BROLL_RULES.fadeMs);
  });

  it("fades in over its first quarter second and out over its last, and is gone outside", () => {
    expect(brollOpacity(CUTAWAY, 3_999)).toBe(0);
    expect(brollOpacity(CUTAWAY, 4_000)).toBe(0);
    expect(brollOpacity(CUTAWAY, 4_125)).toBeCloseTo(0.5, 5);
    expect(brollOpacity(CUTAWAY, 5_500)).toBe(1);
    expect(brollOpacity(CUTAWAY, 6_875)).toBeCloseTo(0.5, 5);
    expect(brollOpacity(CUTAWAY, 7_000)).toBe(0);
  });

  it("fades over a third of a cutaway too short for the full fade", () => {
    const short = { startMs: 0, endMs: 600 };
    expect(brollOpacity(short, 100)).toBeCloseTo(0.5, 5);
    expect(brollOpacity(short, 300)).toBe(1);
  });

  it("gives way to a hook title or an end card up at the same time", () => {
    const title: HookTitleTrack = {
      id: "01JHOOK0000000000000000000",
      kind: "hook-title",
      text: "Part 2 next",
      startMs: 6_000,
      endMs: 8_000,
    };
    expect(brollOpacity(CUTAWAY, 5_000, [title])).toBe(1);
    expect(brollOpacity(CUTAWAY, 5_875, [title])).toBeCloseTo(0.5, 5);
    expect(brollOpacity(CUTAWAY, 6_500, [title])).toBe(0);
    // A logo is not a reason to give way.
    const logo: LogoTrack = {
      id: "01JLOGO0000000000000000000",
      kind: "logo",
      startMs: 0,
      endMs: 10_000,
      image: CUTAWAY.image,
      corner: "top-right",
      sizePct: 16,
      opacity: 1,
      marginPct: 4,
    };
    expect(brollOpacity(CUTAWAY, 6_500, [logo])).toBe(1);
  });
});

describe("full frame", () => {
  const layout = layoutBRoll({ overlay: CUTAWAY, canvas: PORTRAIT });

  it("covers the frame, centred, and clips the picture to it", () => {
    const picture = brollPictureRect(layout, CUTAWAY.startMs);
    // 1200x1800 covering 1080x1920: scaled by 1920/1800, so 1280 wide.
    expect(height(picture)).toBeCloseTo(1920, 3);
    expect(width(picture)).toBeCloseTo(1280, 3);
    expect(centreX(picture)).toBeCloseTo(540, 3);
    const [command] = drawBRoll(layout, 5_000, 1);
    expect(command).toMatchObject({
      kind: "clip",
      shape: { type: "rect", rect: [0, 0, 1080, 1920] },
    });
  });

  it("pushes in slowly and evenly, and pulls out the other way", () => {
    const at = (ms: number) => height(brollPictureRect(layout, ms)) / 1920;
    expect(at(4_000)).toBeCloseTo(1, 5);
    expect(at(5_500)).toBeCloseTo(1 + (BROLL_ZOOM - 1) / 2, 5);
    expect(at(7_000)).toBeCloseTo(BROLL_ZOOM, 5);
    const out = layoutBRoll({ overlay: { ...CUTAWAY, motion: "pull-out" }, canvas: PORTRAIT });
    expect(height(brollPictureRect(out, 4_000)) / 1920).toBeCloseTo(BROLL_ZOOM, 5);
    expect(height(brollPictureRect(out, 7_000)) / 1920).toBeCloseTo(1, 5);
  });

  it("pans across at most its travel, left or right, and never uncovers the frame", () => {
    const left = layoutBRoll({ overlay: { ...CUTAWAY, motion: "pan-left" }, canvas: PORTRAIT });
    const start = brollPictureRect(left, 4_000);
    const end = brollPictureRect(left, 7_000);
    expect(centreX(start)).toBeGreaterThan(540);
    expect(centreX(end)).toBeLessThan(540);
    expect(centreX(start) - centreX(end)).toBeLessThanOrEqual(1080 * BROLL_PAN_TRAVEL + 1e-6);
    for (const rect of [start, end]) {
      expect(rect[0]).toBeLessThanOrEqual(0);
      expect(rect[2]).toBeGreaterThanOrEqual(1080);
    }
    const right = layoutBRoll({ overlay: { ...CUTAWAY, motion: "pan-right" }, canvas: PORTRAIT });
    expect(centreX(brollPictureRect(right, 4_000))).toBeLessThan(540);
  });

  it("stays still without motion, and draws nothing fully faded", () => {
    const still = layoutBRoll({ overlay: { ...CUTAWAY, motion: "none" }, canvas: PORTRAIT });
    expect(brollPictureRect(still, 4_000)).toEqual(brollPictureRect(still, 6_900));
    expect(drawBRoll(layout, 5_000, 0)).toEqual([]);
    const [faded] = drawBRoll(layout, 5_000, 0.5);
    const picture = [...walkCommands(faded === undefined ? [] : [faded])].find(
      (command) => command.kind === "image",
    );
    expect(picture).toMatchObject({ opacity: 0.5, assetId: CUTAWAY.image.assetId });
  });
});

describe("picture in picture", () => {
  const pip: BRollTrack = { ...CUTAWAY, mode: "pip" };

  it("is a box a share of the short side wide, at the picture's shape held to 3:4", () => {
    const box = pipRect(pip, PORTRAIT, "top-right");
    expect(width(box)).toBeCloseTo(1080 * PIP_WIDTH, 2);
    // 2:3 is taller than 3:4 allows: held at 3:4.
    expect(height(box) / width(box)).toBeCloseTo(4 / 3, 2);
    expect(box[2]).toBeLessThan(1080);
    // Below a vertical frame's top chrome.
    expect(box[1]).toBeGreaterThanOrEqual(1920 * 0.09 - 1e-6);
    const wide = pipRect(
      { ...pip, image: { ...pip.image, width: 3000, height: 1000 } },
      LANDSCAPE,
      "top-left",
    );
    expect(height(wide) / width(wide)).toBeCloseTo(3 / 4, 2);
  });

  it("takes the top right when nothing is there, and the next slot clear of a face", () => {
    expect(layoutBRoll({ overlay: pip, canvas: PORTRAIT }).slot).toBe("top-right");
    // A face in the top right of the frame for the whole cutaway.
    const faces: CanvasFaceTrack = {
      intervalMs: 250,
      times: [4_000, 5_000, 6_000, 7_000],
      boxes: Array.from({ length: 4 }, () => [[0.6, 0.1, 0.9, 0.3] as Rect]),
    };
    const placed = layoutBRoll({ overlay: pip, canvas: PORTRAIT, faces });
    expect(placed.slot).toBe("top-left");
    expect(placed.frame).toEqual(pipRect(pip, PORTRAIT, "top-left"));
  });

  it("keeps off the captions, and falls back to the top right when nothing is clear", () => {
    // Captions pinned across the top of the frame, clear of its middle.
    const captions: Rect[] = [[0, 100, 1080, 600]];
    const placed = layoutBRoll({ overlay: pip, canvas: PORTRAIT, obstacles: captions });
    expect(placed.slot).toBe("middle-right");
    expect(captions.some((caption) => overlaps(caption, placed.frame))).toBe(false);
    const everywhere: Rect[] = [[0, 0, 1080, 1920]];
    expect(layoutBRoll({ overlay: pip, canvas: PORTRAIT, obstacles: everywhere }).slot).toBe(
      "top-right",
    );
  });

  it("draws a shadowed, rounded box with the picture covering it, as one fading group", () => {
    const layout = layoutBRoll({ overlay: pip, canvas: PORTRAIT });
    const [command] = drawBRoll(layout, 5_000, 0.6);
    expect(command).toMatchObject({ kind: "group", id: `b-roll:${pip.id}`, opacity: 0.6 });
    const kinds = [...walkCommands(command === undefined ? [] : [command])].map((c) => c.kind);
    expect(kinds).toEqual(["group", "shadow", "roundRect", "clip", "image"]);
    const picture = brollPictureRect(layout, 5_000);
    expect(picture[0]).toBeLessThanOrEqual(layout.frame[0]);
    expect(picture[3]).toBeGreaterThanOrEqual(layout.frame[3]);
  });
});

describe("renderFrame with a cutaway", () => {
  const WORDS = [
    { wid: "0:0", s: 0, e: 2_000, t: "Taj" },
    { wid: "0:1", s: 2_000, e: 4_000, t: "Mahal" },
    { wid: "0:2", s: 4_000, e: 6_000, t: "dekhne" },
    { wid: "0:3", s: 6_000, e: 8_000, t: "chalo" },
  ];
  const projection = (overlays?: EdgProjection["overlays"]): EdgProjection => ({
    canvas: PORTRAIT,
    styles: { defaultStyleId: "punch-pop" },
    segments: [
      { id: "seg-a", seq: "V", startWordId: "0:0", endWordId: "0:3", startMs: 0, endMs: 8_000 },
    ],
    words: WORDS,
    ...(overlays === undefined ? {} : { overlays }),
  });
  const frame = (value: EdgProjection, outputMs: number): DrawCommand[] =>
    renderFrame({ projection: value, timemap: null, catalogue, registry, shaper, outputMs });

  it("draws the cutaway first, under the captions, and only while it is up", () => {
    const withCutaway = projection([CUTAWAY]);
    const during = frame(withCutaway, 5_500);
    const captions = frame(projection(), 5_500);
    expect(during[0]).toMatchObject({ kind: "clip" });
    expect(during.slice(1)).toEqual(captions);
    for (const outputMs of [1_000, 7_500]) {
      expect(hashCommands(frame(withCutaway, outputMs))).toBe(
        hashCommands(frame(projection(), outputMs)),
      );
    }
  });

  it("names its picture among the images a host registers", () => {
    expect(overlayImageIds([CUTAWAY])).toEqual([CUTAWAY.image.assetId]);
  });

  it("places a picture-in-picture box off the captions shown while it is up", () => {
    const pip: BRollTrack = { ...CUTAWAY, mode: "pip" };
    const commands = frame(projection([pip]), 5_500);
    const box = [...walkCommands(commands)].find((command) => command.kind === "roundRect");
    const glyphs = [...walkCommands(commands)].filter((command) => command.kind === "text");
    expect(box).toBeDefined();
    expect(glyphs.length).toBeGreaterThan(0);
    // Drawn the same way every time: placed once, per document.
    expect(hashCommands(frame(projection([pip]), 5_500))).toBe(hashCommands(commands));
  });
});
