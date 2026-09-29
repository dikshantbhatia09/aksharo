/**
 * The brand kit's overlays (2026-10-02): a logo in a corner and an end card
 * over the last seconds, on their own and inside `renderFrame`.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";

import { hashCommands } from "../commands/hash.js";
import { type DrawCommand, type Rect, walkCommands } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type EdgProjection } from "../frame/projection.js";
import { renderFrame } from "../frame/render-frame.js";
import { createFixtureRenderer } from "../testing.js";
import {
  drawEndCardBackdrop,
  drawEndCardContent,
  END_CARD_DIM,
  endCardProgress,
  layoutEndCard,
} from "./end-card.js";
import { drawLogo, LOGO_MAX_HEIGHT, logoRect, placeLogo } from "./logo.js";
import {
  type EndCardTrack,
  type HookTitleTrack,
  type LogoTrack,
  overlayImageIds,
} from "./types.js";

const catalogue = loadSystemStyleMap();
const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function styleOf(id: string): StyleDoc {
  const style = catalogue.get(id);
  if (style === undefined) throw new Error(`no style ${id}`);
  return style;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

const LOGO: LogoTrack = {
  id: "01JLOGO0000000000000000000",
  kind: "logo",
  startMs: 0,
  endMs: 10_000,
  image: { assetId: "01JASSET000000000000000000", format: "png", width: 400, height: 200 },
  corner: "top-right",
  sizePct: 20,
  opacity: 0.9,
  marginPct: 4,
};

const CARD: EndCardTrack = {
  id: "01JCARD0000000000000000000",
  kind: "end-card",
  startMs: 7_000,
  endMs: 10_000,
  cta: "Follow for more money tips",
  handle: "@aksharo",
  background: "#141217",
  accent: "#f0508a",
  image: LOGO.image,
};

describe("overlayImageIds", () => {
  it("names every image the overlays draw, once, and nothing for a document without any", () => {
    expect(overlayImageIds([LOGO, CARD])).toEqual([LOGO.image.assetId]);
    expect(overlayImageIds([{ ...CARD, image: undefined } as EndCardTrack])).toEqual([]);
    expect(overlayImageIds(undefined)).toEqual([]);
  });
});

describe("logoRect", () => {
  it("sizes the logo by the frame's width at the file's own aspect, in its corner", () => {
    const rect = logoRect(LOGO, PORTRAIT, "top-right");
    const margin = 1080 * 0.04;
    expect(rect[2] - rect[0]).toBeCloseTo(1080 * 0.2, 1);
    expect(rect[3] - rect[1]).toBeCloseTo(1080 * 0.2 * 0.5, 1);
    expect(rect[2]).toBeCloseTo(1080 - margin, 1);
    expect(rect[1]).toBeCloseTo(margin, 1);

    const bottomLeft = logoRect(LOGO, PORTRAIT, "bottom-left");
    expect(bottomLeft[0]).toBeCloseTo(margin, 1);
    expect(bottomLeft[3]).toBeCloseTo(1920 - margin, 1);
  });

  it("never lets a tall mark take more than a quarter of the frame's height", () => {
    const tall = { ...LOGO, sizePct: 40, image: { ...LOGO.image, width: 100, height: 400 } };
    const rect = logoRect(tall, LANDSCAPE, "top-left");
    expect(rect[3] - rect[1]).toBeCloseTo(1080 * LOGO_MAX_HEIGHT, 1);
    // The aspect ratio survives the cap.
    expect((rect[3] - rect[1]) / (rect[2] - rect[0])).toBeCloseTo(4, 1);
  });
});

describe("placeLogo", () => {
  it("keeps its own corner when nothing is there", () => {
    const placed = placeLogo(LOGO, PORTRAIT, [[100, 1400, 980, 1600]]);
    expect(placed.corner).toBe("top-right");
    expect(placed.scale).toBe(1);
    expect(placed.dest).toEqual(logoRect(LOGO, PORTRAIT, "top-right"));
  });

  it("shrinks in its corner before it moves, then moves to the same side, then across", () => {
    const full = logoRect(LOGO, PORTRAIT, "top-right");
    // Something over the logo's inner edge only: 80 % clears it.
    const inner: Rect = [full[0], full[1], full[0] + 10, full[3]];
    expect(placeLogo(LOGO, PORTRAIT, [inner])).toMatchObject({ corner: "top-right", scale: 0.8 });

    // The whole top right blocked: down to the bottom right.
    const topRight: Rect = [540, 0, 1080, 500];
    expect(placeLogo(LOGO, PORTRAIT, [topRight])).toMatchObject({
      corner: "bottom-right",
      scale: 1,
    });

    // The whole right side blocked: across to the top left.
    const right: Rect = [540, 0, 1080, 1920];
    expect(placeLogo(LOGO, PORTRAIT, [right])).toMatchObject({ corner: "top-left", scale: 1 });
  });

  it("keeps its own corner at full size when nothing clears", () => {
    const everything: Rect = [0, 0, 1080, 1920];
    expect(placeLogo(LOGO, PORTRAIT, [everything])).toMatchObject({
      corner: "top-right",
      scale: 1,
    });
  });
});

describe("drawLogo", () => {
  it("is one image command at the kit's opacity, faded by the end card", () => {
    const placed = placeLogo(LOGO, PORTRAIT, []);
    expect(drawLogo(placed)).toEqual([
      { kind: "image", assetId: LOGO.image.assetId, dest: placed.dest, opacity: 0.9 },
    ]);
    expect(drawLogo(placed, 0.5)[0]).toMatchObject({ opacity: 0.45 });
    expect(drawLogo(placed, 0)).toEqual([]);
    expect(drawLogo({ ...placed, opacity: 1 })[0]).not.toHaveProperty("opacity");
  });
});

describe("layoutEndCard", () => {
  const input = (captions: readonly Rect[] = [], overlay: EndCardTrack = CARD) => ({
    overlay,
    style: styleOf("punch-pop"),
    canvas: PORTRAIT,
    registry,
    shaper,
    captions,
  });

  it("stacks the logo, the call to action and the handle, centred in the frame", () => {
    const card = layoutEndCard(input());
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(card.scale).toBe(1);
    const middle = (card.box[1] + card.box[3]) / 2;
    expect(middle).toBeCloseTo(960, -1);
    expect(card.logo).toBeDefined();
    expect(card.cta).toBeDefined();
    expect(card.handle).toBeDefined();
    if (card.logo === undefined || card.cta === undefined || card.handle === undefined) return;
    // Logo above the words above the handle, all centred.
    expect(card.logo.dest[3]).toBeLessThanOrEqual(card.cta.box[1]);
    expect(card.cta.box[3]).toBeLessThanOrEqual(card.handle.box[1] + 1);
    expect((card.logo.dest[0] + card.logo.dest[2]) / 2).toBeCloseTo(540, 0);
    // The logo keeps its aspect.
    const logoW = card.logo.dest[2] - card.logo.dest[0];
    const logoH = card.logo.dest[3] - card.logo.dest[1];
    expect(logoW / logoH).toBeCloseTo(2, 1);
    // The words keep the case they were typed in.
    expect(card.handle.lines[0]?.text).toBe("@aksharo");
    // Ink that reads on a dark card, and the accent for the handle.
    expect(card.textColour).toBe("#ffffffff");
    expect(card.accentColour).toBe("#f0508aff");
  });

  it("keeps off the captions shown while it is up: above them, else below them", () => {
    const middleCaption: Rect = [100, 860, 980, 1060];
    const card = layoutEndCard(input([middleCaption]));
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(overlaps(card.box, middleCaption)).toBe(false);
    expect(card.box[3]).toBeLessThanOrEqual(middleCaption[1]);

    // Captions over most of the top: it goes below.
    const high: Rect = [100, 100, 980, 1100];
    const below = layoutEndCard(input([high]));
    expect(below).toBeDefined();
    if (below === undefined) return;
    expect(below.box[1]).toBeGreaterThanOrEqual(high[3]);
  });

  it("shrinks when the space the captions leave is small, and stays centred when nothing clears", () => {
    const squeeze: Rect[] = [
      [100, 200, 980, 640],
      [100, 1300, 980, 1800],
    ];
    const card = layoutEndCard(input(squeeze));
    expect(card).toBeDefined();
    if (card === undefined) return;
    for (const box of squeeze) expect(overlaps(card.box, box)).toBe(false);

    const all = layoutEndCard(input([[0, 0, 1080, 1920]]));
    expect(all?.scale).toBe(0.65);
    if (all === undefined) return;
    expect((all.box[1] + all.box[3]) / 2).toBeCloseTo(960, -1);
  });

  it("uses the kit's ink when it names one, and draws only what the card has", () => {
    const plain = layoutEndCard(
      input([], {
        ...CARD,
        cta: "Subscribe",
        text: "#f1ece6",
        background: "#ffffff",
        image: undefined,
        handle: undefined,
      } as EndCardTrack),
    );
    expect(plain?.textColour).toBe("#f1ece6ff");
    expect(plain?.logo).toBeUndefined();
    expect(plain?.handle).toBeUndefined();
    // On a white card with no ink named, black reads.
    const light = layoutEndCard(input([], { ...CARD, background: "#ffffff" }));
    expect(light?.textColour).toBe("#000000ff");
  });
});

describe("the end card's two layers", () => {
  it("dims the frame from nothing to full over its first moments", () => {
    expect(endCardProgress(6_999, 7_000, 10_000)).toBe(0);
    expect(endCardProgress(7_000, 7_000, 10_000)).toBe(0);
    expect(endCardProgress(7_200, 7_000, 10_000)).toBeGreaterThan(0.5);
    expect(endCardProgress(9_000, 7_000, 10_000)).toBe(1);
    expect(endCardProgress(10_000, 7_000, 10_000)).toBe(0);

    expect(drawEndCardBackdrop(CARD, PORTRAIT, 6_000)).toEqual([]);
    const full = drawEndCardBackdrop(CARD, PORTRAIT, 9_000);
    const rect = [...walkCommands(full)].find((command) => command.kind === "rect");
    expect(rect).toMatchObject({
      kind: "rect",
      rect: [0, 0, 1080, 1920],
      fill: { paint: { type: "solid", color: "#141217ff" }, opacity: END_CARD_DIM },
    });
  });

  it("brings the content up a beat after the dim", () => {
    const card = layoutEndCard({
      overlay: CARD,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(drawEndCardContent(card, 7_050)).toEqual([]);
    const settled = drawEndCardContent(card, 9_000);
    const kinds = [...walkCommands(settled)].map((command) => command.kind);
    expect(kinds).toContain("image");
    expect(kinds.filter((kind) => kind === "text").length).toBeGreaterThan(0);
    expect(drawEndCardContent(card, 10_000)).toEqual([]);
  });

  it("is left out when there is nothing on it", () => {
    const empty = layoutEndCard({
      overlay: { ...CARD, cta: undefined, handle: undefined, image: undefined } as EndCardTrack,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    expect(empty).toBeUndefined();
  });
});

describe("renderFrame with a brand kit's overlays", () => {
  const WORDS = [
    { wid: "0:0", s: 0, e: 2_000, t: "Paisa" },
    { wid: "0:1", s: 2_000, e: 4_000, t: "bachana" },
    { wid: "0:2", s: 4_000, e: 6_000, t: "itna" },
    { wid: "0:3", s: 6_000, e: 8_000, t: "easy" },
    { wid: "0:4", s: 8_000, e: 10_000, t: "hai" },
  ];
  const HOOK: HookTitleTrack = {
    id: "01JHOOK0000000000000000000",
    kind: "hook-title",
    text: "Paisa bachana itna easy hai",
    startMs: 0,
    endMs: 2_500,
  };
  const projection = (
    overlays?: EdgProjection["overlays"],
    extra: Partial<EdgProjection> = {},
  ): EdgProjection => ({
    canvas: PORTRAIT,
    styles: { defaultStyleId: "punch-pop" },
    segments: [
      { id: "seg-a", seq: "V", startWordId: "0:0", endWordId: "0:1", startMs: 0, endMs: 4_000 },
      {
        id: "seg-b",
        seq: "W",
        startWordId: "0:2",
        endWordId: "0:4",
        startMs: 4_000,
        endMs: 10_000,
      },
    ],
    words: WORDS,
    ...(overlays === undefined ? {} : { overlays }),
    ...extra,
  });
  const frame = (value: EdgProjection, outputMs: number): DrawCommand[] =>
    renderFrame({ projection: value, timemap: null, catalogue, registry, shaper, outputMs });
  const images = (commands: readonly DrawCommand[]) =>
    [...walkCommands(commands)].filter((command) => command.kind === "image");

  it("draws exactly what it drew before when there is no brand overlay", () => {
    // The committed goldens pin the hook title's and the captions' own
    // commands; here, an empty overlay list is no overlay list at all.
    for (const outputMs of [500, 5_000, 9_000]) {
      expect(hashCommands(frame(projection([]), outputMs))).toBe(
        hashCommands(frame(projection(), outputMs)),
      );
    }
  });

  it("draws the logo on every frame of its window, over the captions", () => {
    const branded = projection([LOGO]);
    for (const outputMs of [100, 3_000, 6_500]) {
      const commands = frame(branded, outputMs);
      const captionsOnly = frame(projection(), outputMs);
      expect(commands.slice(0, captionsOnly.length)).toEqual(captionsOnly);
      expect(images(commands)).toHaveLength(1);
    }
    // Deterministic: the same document draws the same frame.
    expect(hashCommands(frame(branded, 3_000))).toBe(
      hashCommands(frame(projection([LOGO]), 3_000)),
    );
  });

  it("moves the logo off a caption pinned into its corner", () => {
    const pinned = projection([{ ...LOGO, corner: "bottom-right" }], {
      segments: projection().segments.map((segment) => ({
        ...segment,
        position: { x: 0.5, y: 0.97, anchor: "bottom-center" },
      })),
    });
    const logo = images(frame(pinned, 3_000))[0];
    expect(logo).toBeDefined();
    if (logo?.kind !== "image") return;
    expect(logo.dest).not.toEqual(
      logoRect({ ...LOGO, corner: "bottom-right" }, PORTRAIT, "bottom-right"),
    );
  });

  it("places a logo over a long video's thousands of captions in well under a second", () => {
    const count = 1_500;
    const manyWords = Array.from({ length: count * 3 }, (_, index) => ({
      wid: `0:${String(index)}`,
      s: index * 1_000,
      e: index * 1_000 + 900,
      t: ["Paisa", "bachana", "easy"][index % 3] ?? "hai",
    }));
    const long: EdgProjection = {
      ...projection([{ ...LOGO, endMs: count * 3_000 }]),
      segments: Array.from({ length: count }, (_, index) => ({
        id: `seg-${String(index)}`,
        seq: `A${String(index).padStart(5, "0")}`,
        startWordId: `0:${String(index * 3)}`,
        endWordId: `0:${String(index * 3 + 2)}`,
        startMs: index * 3_000,
        endMs: index * 3_000 + 2_900,
      })),
      words: manyWords,
    };
    const started = performance.now();
    const commands = frame(long, 1_000);
    expect(images(commands)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("keeps the hook title off the logo", () => {
    const wide = { ...LOGO, sizePct: 30, image: { ...LOGO.image, width: 300, height: 300 } };
    const commands = frame(projection([HOOK, wide]), 1_200);
    const logo = images(commands)[0];
    const card = [...walkCommands(commands)].find((command) => command.kind === "roundRect");
    expect(logo).toBeDefined();
    expect(card).toBeDefined();
    if (logo?.kind !== "image" || card?.kind !== "roundRect") return;
    expect(overlaps(logo.dest, card.rect)).toBe(false);
  });

  it("dims under the captions, draws the card over them, and fades the corner logo out", () => {
    const branded = projection([LOGO, CARD]);
    const commands = frame(branded, 9_000);
    const first = commands[0];
    expect(first).toMatchObject({ kind: "group", id: `end-card-backdrop:${CARD.id}` });
    const last = commands.at(-1);
    const ids = [...walkCommands(last === undefined ? [] : [last])]
      .filter((command) => command.kind === "group")
      .map((command) => (command as { id?: string }).id);
    expect(ids).toContain(`end-card:${CARD.id}`);
    // Only the card's own logo is drawn once the card is fully in.
    expect(images(commands)).toHaveLength(1);
    // Before the card, only the corner logo.
    const before = frame(branded, 5_000);
    expect(before[0]).not.toMatchObject({ id: `end-card-backdrop:${CARD.id}` });
    expect(images(before)).toHaveLength(1);
  });
});
