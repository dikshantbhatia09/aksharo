import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";

import { hashCommands } from "../commands/hash.js";
import { type DrawCommand, type Rect, walkCommands } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type CanvasFaceTrack, faceTrackOnCanvas } from "../frame/placement.js";
import { type EdgProjection } from "../frame/projection.js";
import { renderFrame } from "../frame/render-frame.js";
import { createFixtureRenderer } from "../testing.js";
import {
  balancedBreaks,
  drawHookTitle,
  HookTitleCache,
  hookTitlePhase,
  layoutHookTitle,
  MIN_HOOK_TITLE_SCALE,
  type OverlayTrack,
  renderHookTitles,
} from "./hook-title.js";

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

const HOOK: OverlayTrack = {
  id: "01JHOOK0000000000000000000",
  kind: "hook-title",
  text: "Paisa bachana itna easy hai bhai",
  startMs: 0,
  endMs: 2_500,
};

/** One face filling the middle of a vertical frame, the whole time. */
function faceTrack(box: readonly [number, number, number, number]): CanvasFaceTrack {
  return faceTrackOnCanvas(
    {
      version: 1,
      intervalMs: 250,
      source: { width: 1080, height: 1920 },
      samples: [0, 250, 500, 1_000, 1_500, 2_000, 2_500, 3_000].map((tMs) => [tMs, [[...box]]]),
    },
    PORTRAIT,
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

describe("layoutHookTitle", () => {
  it("puts the card at the top of a vertical frame, centred, in the style's own letter case and colours", () => {
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    expect(title).toBeDefined();
    if (title === undefined) return;
    // Below the platform chrome (9 % of the height), centred horizontally.
    expect(title.card[1]).toBeCloseTo(1920 * 0.09, 0);
    expect((title.card[0] + title.card[2]) / 2).toBeCloseTo(540, 0);
    expect(title.card[0]).toBeGreaterThan(0);
    expect(title.card[2]).toBeLessThan(1080);
    expect(title.scale).toBe(1);
    // Punch Pop is set in capitals, and its highlight colour becomes the card.
    expect(title.layout.lines.map((line) => line.text).join(" ")).toBe(
      "PAISA BACHANA ITNA EASY HAI BHAI",
    );
    expect(title.cardColour).toBe("#ffd400ff");
    expect(title.inkColour).toBe("#000000ff");
  });

  it("wears a brand kit's card, ink and typeface when the title carries them (2026-10-02)", () => {
    const branded = layoutHookTitle({
      overlay: {
        ...HOOK,
        kind: "hook-title",
        appearance: { background: "#f0508a", text: "#0b0a0c", fontFamily: "Poppins" },
      },
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    expect(branded?.cardColour).toBe("#f0508aff");
    expect(branded?.inkColour).toBe("#0b0a0cff");
    const fontIds = new Set(
      (branded?.layout.lines ?? []).flatMap((line) => line.runs.map((run) => run.fontId)),
    );
    expect([...fontIds].some((id) => id.startsWith("poppins-"))).toBe(true);

    // A card colour alone picks its own ink, as the style's does.
    const light = layoutHookTitle({
      overlay: { ...HOOK, kind: "hook-title", appearance: { background: "#ffffff" } },
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    expect(light?.inkColour).toBe("#000000ff");
  });

  it("balances the lines instead of leaving a straggler", () => {
    const title = layoutHookTitle({
      overlay: { ...HOOK, text: "Ye ek galti aapka poora paisa kha jaati hai" },
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    const widths = (title?.layout.lines ?? []).map((line) => line.box[2] - line.box[0]);
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.5);
  });

  it("keeps off a face that fills the top of the frame, and never covers it", () => {
    const faces = faceTrack([0.25, 0.12, 0.5, 0.25]);
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
      faces,
    });
    expect(title).toBeDefined();
    if (title === undefined) return;
    const face: Rect = [0.25 * 1080, 0.12 * 1920, 0.75 * 1080, 0.37 * 1920];
    expect(overlaps(title.card, face)).toBe(false);
    // It moved below the face rather than disappearing.
    expect(title.card[1]).toBeGreaterThanOrEqual(face[3]);
    expect(title.card[3]).toBeLessThanOrEqual(1920 * 0.7);
  });

  it("shrinks to fit above a face that leaves a little room at the top", () => {
    const faces = faceTrack([0.3, 0.3, 0.4, 0.35]);
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
      faces,
    });
    expect(title).toBeDefined();
    if (title === undefined) return;
    const face: Rect = [0.3 * 1080, 0.3 * 1920, 0.7 * 1080, 0.65 * 1920];
    expect(overlaps(title.card, face)).toBe(false);
    expect(title.card[1]).toBeCloseTo(1920 * 0.09, 0);
  });

  it("keeps off the captions shown while it is up", () => {
    const caption: Rect = [80, 150, 1000, 420];
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
      captions: [caption],
    });
    expect(title).toBeDefined();
    if (title === undefined) return;
    expect(overlaps(title.card, caption)).toBe(false);
  });

  it("still draws, small and at the top, when a face fills the whole frame", () => {
    const faces = faceTrack([0.02, 0.02, 0.96, 0.9]);
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
      faces,
    });
    expect(title?.scale).toBe(MIN_HOOK_TITLE_SCALE);
    expect(title?.card[1]).toBeCloseTo(1920 * 0.09, 0);
  });

  it("shapes Devanagari with real glyphs", () => {
    const title = layoutHookTitle({
      overlay: { ...HOOK, text: "पैसा बचाना बहुत आसान है" },
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    const glyphs = (title?.layout.lines ?? []).flatMap((line) =>
      line.runs.flatMap((run) => run.glyphs.map((glyph) => glyph.id)),
    );
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs).not.toContain(0);
  });

  it("uses less of a wide frame and a plain top margin", () => {
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: LANDSCAPE,
      registry,
      shaper,
    });
    expect(title).toBeDefined();
    if (title === undefined) return;
    expect(title.card[1]).toBeCloseTo(1080 * 0.06, 0);
    expect(title.card[2] - title.card[0]).toBeLessThan(1920 * 0.72);
  });

  it("returns nothing for words that are only spaces", () => {
    expect(
      layoutHookTitle({
        overlay: { ...HOOK, text: "   " },
        style: styleOf("punch-pop"),
        canvas: PORTRAIT,
        registry,
        shaper,
      }),
    ).toBeUndefined();
  });
});

describe("hookTitlePhase", () => {
  it("drops in, holds, and fades out inside its window", () => {
    const start = hookTitlePhase(0, 0, 2_500);
    const held = hookTitlePhase(1_200, 0, 2_500);
    const late = hookTitlePhase(2_450, 0, 2_500);
    expect(start.opacity).toBe(0);
    expect(start.dyEm).toBeLessThan(0);
    expect(held).toEqual({ opacity: 1, scale: 1, dyEm: 0 });
    expect(late.opacity).toBeGreaterThan(0);
    expect(late.opacity).toBeLessThan(1);
  });

  it("scales entry and exit down for a short window", () => {
    const mid = hookTitlePhase(400, 0, 800);
    expect(mid.opacity).toBe(1);
  });
});

describe("drawHookTitle", () => {
  it("draws the card under its words, as one group at the phase's opacity", () => {
    const title = layoutHookTitle({
      overlay: HOOK,
      style: styleOf("punch-pop"),
      canvas: PORTRAIT,
      registry,
      shaper,
    });
    if (title === undefined) throw new Error("no title");
    const commands = drawHookTitle(title, { opacity: 0.5, scale: 1, dyEm: 0 });
    const all = [...walkCommands(commands)];
    const kinds = all.map((command) => command.kind);
    expect(kinds).toContain("roundRect");
    expect(kinds.filter((kind) => kind === "text").length).toBeGreaterThan(0);
    const groupCommand = all.find((command) => command.kind === "group");
    expect(groupCommand).toMatchObject({ opacity: 0.5, id: `hook-title:${HOOK.id}` });
    expect(drawHookTitle(title, { opacity: 0, scale: 1, dyEm: 0 })).toEqual([]);
  });
});

describe("renderHookTitles", () => {
  it("lays each title out once per owner, however many frames draw it", () => {
    const cache = new HookTitleCache();
    let asked = 0;
    const owner = {};
    const draw = (sourceMs: number): DrawCommand[] =>
      renderHookTitles({
        overlays: [HOOK],
        sourceMs,
        style: styleOf("punch-pop"),
        canvas: PORTRAIT,
        registry,
        shaper,
        captionsDuring: () => {
          asked += 1;
          return [];
        },
        cache,
        cacheOwner: owner,
      });
    expect(draw(500).length).toBe(1);
    expect(draw(1_000).length).toBe(1);
    expect(draw(2_500)).toEqual([]);
    expect(asked).toBe(1);
  });

  it("draws nothing without a style, or for a kind it does not know", () => {
    const base = {
      sourceMs: 500,
      canvas: PORTRAIT,
      registry,
      shaper,
      captionsDuring: () => [],
      cache: new HookTitleCache(),
      cacheOwner: {},
    };
    expect(renderHookTitles({ ...base, overlays: [HOOK], style: undefined })).toEqual([]);
    expect(
      renderHookTitles({
        ...base,
        overlays: [{ ...HOOK, kind: "sticker" as unknown as "hook-title" }],
        style: styleOf("punch-pop"),
      }),
    ).toEqual([]);
  });
});

describe("renderFrame with overlays", () => {
  const WORDS = [
    { wid: "0:0", s: 0, e: 600, t: "Bhai" },
    { wid: "0:1", s: 600, e: 1_200, t: "aaj" },
    { wid: "0:2", s: 1_200, e: 1_800, t: "baat" },
    { wid: "0:3", s: 1_800, e: 2_400, t: "karenge" },
  ];
  const projection = (overlays?: readonly OverlayTrack[]): EdgProjection => ({
    canvas: PORTRAIT,
    styles: { defaultStyleId: "punch-pop" },
    segments: [
      {
        id: "seg-a",
        seq: "V",
        startWordId: "0:0",
        endWordId: "0:3",
        startMs: 0,
        endMs: 2_400,
      },
    ],
    words: WORDS,
    ...(overlays === undefined ? {} : { overlays }),
  });
  const frame = (value: EdgProjection, outputMs: number): DrawCommand[] =>
    renderFrame({ projection: value, timemap: null, catalogue, registry, shaper, outputMs });

  it("draws exactly what it drew before when the projection carries no overlay", () => {
    for (const outputMs of [300, 1_300, 2_200]) {
      expect(hashCommands(frame(projection([]), outputMs))).toBe(
        hashCommands(frame(projection(), outputMs)),
      );
    }
  });

  it("adds the hook title over the captions inside its window, and only there", () => {
    const withHook = projection([HOOK]);
    const inside = frame(withHook, 1_300);
    const captionsOnly = frame(projection(), 1_300);
    expect(inside.slice(0, captionsOnly.length)).toEqual(captionsOnly);
    const ids = [...walkCommands(inside)]
      .filter((command) => command.kind === "group")
      .map((command) => (command as { id?: string }).id);
    expect(ids).toContain(`hook-title:${HOOK.id}`);
    expect(frame(withHook, 2_600)).toEqual(frame(projection(), 2_600));
  });

  it("keeps the card off the caption shown at the same time", () => {
    // A caption style pinned to the top of the frame, where the hook wants to be.
    const topCaption = projection([HOOK]);
    const moved: EdgProjection = {
      ...topCaption,
      segments: topCaption.segments.map((segment) => ({
        ...segment,
        position: { x: 0.5, y: 0.1, anchor: "top-center" },
      })),
    };
    const commands = frame(moved, 1_300);
    const card = [...walkCommands(commands)].find((command) => command.kind === "roundRect");
    const text = [...walkCommands(commands)].find((command) => command.kind === "text");
    expect(card).toBeDefined();
    expect(text).toBeDefined();
    if (card?.kind !== "roundRect") return;
    // The caption's first glyph sits at the top; the card is below it.
    if (text?.kind !== "text") return;
    const captionBaseline = text.run.positions[1] ?? 0;
    expect(card.rect[1]).toBeGreaterThan(captionBaseline);
  });
});

describe("balancedBreaks", () => {
  it("makes the longest line as short as it can be, then the lines as even as they can be", () => {
    // PAISA BACHANE KA SABSE EASY TARIKA
    const counts = [5, 7, 2, 5, 4, 6];
    // Three lines: 13 / 8 / 11 beats a greedy 13 / 13 / 6.
    expect(balancedBreaks(counts, 3)).toEqual([2, 4]);
    // Two lines: 16 / 17.
    expect(balancedBreaks(counts, 2)).toEqual([3]);
  });

  it("has nothing to break for one line or one word, and never more lines than words", () => {
    expect(balancedBreaks([5, 7], 1)).toEqual([]);
    expect(balancedBreaks([12], 3)).toEqual([]);
    expect(balancedBreaks([3, 4], 3)).toEqual([1]);
  });
});
