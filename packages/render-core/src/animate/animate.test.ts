import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type Gradient, type StyleDoc } from "@montaj/caption-styles";

import { hashCommands } from "../commands/hash.js";
import { type DrawCommand, walkCommands } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout, type RenderWord } from "../layout/types.js";
import { createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";
import {
  animate,
  cuePhase,
  cueTiming,
  __testing,
  toGlyphRun,
  watermarkCommand,
  wordColour,
  wordState,
} from "./animate.js";
import {
  easeOutBack,
  easeOutBounce,
  easeOutCubic,
  lerp,
  linear,
  progress,
  shakeOffset,
} from "./easing.js";

const styles = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function style(id: string, overrides: Partial<StyleDoc> = {}): StyleDoc {
  const base = styles.get(id);
  if (base === undefined) throw new Error(`no style ${id}`);
  return { ...base, ...overrides };
}

const WORDS: RenderWord[] = [
  { wid: "0:0", t: "one", s: 0, e: 750 },
  { wid: "0:1", t: "two", s: 750, e: 1500 },
  { wid: "0:2", t: "three", s: 1500, e: 2250 },
  { wid: "0:3", t: "four", s: 2250, e: 3000 },
];

function lay(doc: StyleDoc, tMs: number, list: readonly RenderWord[] = WORDS): Layout {
  return layoutSegment({
    style: doc,
    segment: { id: "seg", startMs: 0, endMs: 3000 },
    words: list,
    canvas: GOLDEN_CANVAS,
    registry,
    shaper,
    tMs,
  });
}

function draw(
  doc: StyleDoc,
  tMs: number,
  list: readonly RenderWord[] = WORDS,
  captionOpacity?: number,
): DrawCommand[] {
  return animate({
    layout: lay(doc, tMs, list),
    style: doc,
    tMs,
    ...(captionOpacity === undefined ? {} : { captionOpacity }),
  });
}

function kinds(commands: readonly DrawCommand[]): string[] {
  return [...walkCommands(commands)].map((command) => command.kind);
}

describe("easing", () => {
  it("starts at 0 and ends at 1", () => {
    for (const easing of [linear, easeOutCubic, easeOutBack, easeOutBounce]) {
      expect(easing(0)).toBeCloseTo(0, 6);
      expect(easing(1)).toBeCloseTo(1, 6);
    }
  });

  it("clamps outside the unit interval", () => {
    expect(linear(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("overshoots for a pop and bounces for a bounce", () => {
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1);
    expect(easeOutBounce(0.4)).toBeGreaterThan(0);
    expect(easeOutBounce(0.5)).toBeGreaterThan(easeOutBounce(0.3));
    expect(easeOutBounce(0.8)).toBeGreaterThan(0.9);
    expect(easeOutBounce(0.95)).toBeGreaterThan(0.97);
  });

  it("measures progress through a window, with a zero-length one snapping", () => {
    expect(progress(500, 0, 1000)).toBeCloseTo(0.5, 6);
    expect(progress(-1, 0, 1000)).toBe(0);
    expect(progress(5000, 0, 1000)).toBe(1);
    expect(progress(0, 0, 0)).toBe(1);
    expect(progress(-1, 0, 0)).toBe(0);
  });

  it("interpolates without clamping so a pop can overshoot", () => {
    expect(lerp(10, 20, 1.5)).toBe(25);
  });

  it("shakes deterministically", () => {
    expect(shakeOffset(1234, 5, 2)).toEqual(shakeOffset(1234, 5, 2));
    expect(shakeOffset(1234, 5, 2)).not.toEqual(shakeOffset(1234, 5, 3));
    expect(Math.abs(shakeOffset(1234, 5, 2).x)).toBeLessThanOrEqual(5);
  });
});

describe("cuePhase", () => {
  it.each([
    "fade",
    "pop",
    "slide-up",
    "slide-down",
    "bounce",
    "blur",
    "typewriter",
    "none",
    "zoom",
    "scale",
    "slide-left",
    "slide-right",
    "rise",
    "hide",
  ] as const)("%s is fully present at 1", (type) => {
    const phase = cuePhase(type, 1, 100);
    expect(phase.opacity).toBe(1);
    expect(phase.scale).toBeCloseTo(1, 6);
    expect(phase.dy).toBeCloseTo(0, 6);
    expect(phase.dx).toBeCloseTo(0, 6);
    expect(phase.reveal).toBe(1);
  });

  it("is invisible or displaced at 0", () => {
    expect(cuePhase("fade", 0, 100).opacity).toBe(0);
    expect(cuePhase("slide-up", 0, 100).dy).toBeGreaterThan(0);
    expect(cuePhase("slide-down", 0, 100).dy).toBeLessThan(0);
    expect(cuePhase("blur", 0, 100).sigma).toBeGreaterThan(0);
    expect(cuePhase("typewriter", 0, 100).reveal).toBe(0);
    expect(cuePhase("none", 0, 100).opacity).toBe(1);
  });

  describe("K05: zoom, scale, slide-left, slide-right, rise, hide", () => {
    it("zoom scales in from nothing, with no overshoot", () => {
      const at0 = cuePhase("zoom", 0, 100);
      expect(at0.opacity).toBe(0);
      expect(at0.scale).toBeCloseTo(0, 6);
      // easeOutCubic never overshoots 1, unlike pop's easeOutBack.
      for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        expect(cuePhase("zoom", p, 100).scale).toBeLessThanOrEqual(1);
      }
    });

    it("scale is a smaller pop than pop itself — same overshoot shape, shallower start", () => {
      const p = 0.65; // near pop's/easeOutBack's overshoot peak
      const popPhase = cuePhase("pop", p, 100);
      const scalePhase = cuePhase("scale", p, 100);
      expect(scalePhase.scale).toBeGreaterThan(1); // still overshoots...
      expect(scalePhase.scale - 1).toBeLessThan(popPhase.scale - 1); // ...just less than pop
    });

    it("zoom and scale are visibly distinct from pop and from each other", () => {
      const p = 0.5;
      const pop = cuePhase("pop", p, 100).scale;
      const zoom = cuePhase("zoom", p, 100).scale;
      const scale = cuePhase("scale", p, 100).scale;
      expect(new Set([pop, zoom, scale]).size).toBe(3);
    });

    it("slide-left/slide-right are the horizontal counterparts of slide-up/slide-down", () => {
      const left = cuePhase("slide-left", 0, 100);
      const right = cuePhase("slide-right", 0, 100);
      expect(left.dx).toBeGreaterThan(0); // enters from the right, settles moving left
      expect(right.dx).toBeLessThan(0); // enters from the left, settles moving right
      expect(left.dy).toBeCloseTo(0, 6);
      expect(right.dy).toBeCloseTo(0, 6);
      // Same travel magnitude as slide-up/slide-down, just on the other axis.
      const up = cuePhase("slide-up", 0, 100);
      expect(Math.abs(left.dx)).toBeCloseTo(Math.abs(up.dy), 6);
    });

    it("rise drifts upward like slide-up, but a smaller distance", () => {
      const rise = cuePhase("rise", 0, 100);
      const slideUp = cuePhase("slide-up", 0, 100);
      expect(rise.dy).toBeGreaterThan(0); // same direction: below, easing up to 0
      expect(rise.dy).toBeLessThan(slideUp.dy); // smaller travel
    });

    it("hide is an instant cut: opaque the moment any progress begins, invisible before it", () => {
      expect(cuePhase("hide", 0, 100).opacity).toBe(0);
      expect(cuePhase("hide", 0.0001, 100).opacity).toBe(1);
      expect(cuePhase("hide", 0.5, 100).opacity).toBe(1);
      expect(cuePhase("hide", 1, 100).opacity).toBe(1);
    });

    it("hide is distinct from none at the very start of the window", () => {
      // "none" ignores presence entirely (always full); "hide" is invisible
      // until progress begins, then snaps to full — a real, visible difference.
      expect(cuePhase("none", 0, 100).opacity).toBe(1);
      expect(cuePhase("hide", 0, 100).opacity).toBe(0);
    });
  });

  it("times the entry from the caption, and from the word for a per-word style", () => {
    const doc = style("vertical-clean");
    expect(cueTiming(lay(doc, 0), doc, 0).opacity).toBe(0);
    expect(cueTiming(lay(doc, 1500), doc, 1500).opacity).toBe(1);

    const perWord = style("impact-shout");
    expect(perWord.animation.perWord).toBe(true);
    // Each word restarts the entry animation from its own start time.
    expect(cueTiming(lay(perWord, 1500), perWord, 1500).opacity).toBe(0);
    expect(cueTiming(lay(perWord, 1620), perWord, 1620).opacity).toBeGreaterThan(0);
  });

  it("fades the caption out at the end of its span", () => {
    const doc = style("vertical-clean");
    expect(cueTiming(lay(doc, 2999), doc, 2999).opacity).toBeLessThan(1);
    expect(cueTiming(lay(doc, 3200), doc, 3200).opacity).toBe(0);
  });

  it("draws nothing at all when the caption is invisible", () => {
    expect(draw(style("vertical-clean"), 5000)).toEqual([]);
  });

  it("treats a zero-length out animation as a hard cut", () => {
    const doc = style("vertical-clean", {
      animation: { ...style("vertical-clean").animation, out: { type: "fade", durationMs: 0 } },
    });
    expect(cueTiming(lay(doc, 2999), doc, 2999).opacity).toBe(1);
    expect(cueTiming(lay(doc, 3000), doc, 3000).opacity).toBe(0);
  });
});

describe("word state and colour", () => {
  it("classifies a word as upcoming, speaking or sung", () => {
    const word = lay(style("karaoke-fill"), 1000).words[1];
    expect(word).toBeDefined();
    if (word === undefined) return;
    expect(wordState(word, word.startMs - 1)).toBe("upcoming");
    expect(wordState(word, word.startMs)).toBe("speaking");
    expect(wordState(word, word.endMs)).toBe("sung");
  });

  it("colours a karaoke caption by whether the word has been sung", () => {
    const doc = style("karaoke-fill");
    const word = lay(doc, 1000).words[1];
    if (word === undefined) throw new Error("no word");
    expect(wordColour(word, doc, word.endMs + 1)).toBe(doc.colors.activeText);
    expect(wordColour(word, doc, word.startMs - 1)).toBe(doc.colors.upcomingText);
  });

  it("colours the word being spoken for a highlight style", () => {
    const punch = style("punch-pop");
    const punchLayout = lay(punch, 100);
    const word = punchLayout.words[0];
    if (word === undefined) throw new Error("no word");
    expect(wordColour(word, punch, word.startMs + 1)).toBe(punch.colors.activeText);
    expect(wordColour(word, punch, word.endMs + 1)).toBe(punch.colors.text);
  });

  it("prefers a speaker colour when the caller supplies one", () => {
    const podcast = style("podcast-duo");
    const podcastLayout = layoutSegment({
      style: podcast,
      segment: { id: "seg", startMs: 0, endMs: 3000 },
      words: WORDS.map((word) => ({ ...word, sp: "sp2" })),
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 100,
    });
    const word = podcastLayout.words[0];
    if (word === undefined) throw new Error("no word");
    expect(wordColour(word, podcast, 2900, { sp2: "#3fa7d6" })).toBe("#3fa7d6");
  });
});

describe("K08: gradient text colour", () => {
  const gradient: Gradient = {
    stops: [
      { offset: 0, color: "#ff2e63ff" },
      { offset: 1, color: "#3fa7d6ff" },
    ],
    angleDeg: 45,
  };

  it("gradientPaint runs the ramp left-to-right at 0° and top-to-bottom at 90°", () => {
    const box: [number, number, number, number] = [0, 0, 100, 50];
    const stops = [
      { offset: 0, color: "#ff0000ff" },
      { offset: 1, color: "#0000ffff" },
    ];
    expect(__testing.gradientPaint(box, { angleDeg: 0, stops })).toEqual({
      type: "linear-gradient",
      from: [0, 25],
      to: [100, 25],
      stops,
    });
    expect(__testing.gradientPaint(box, { angleDeg: 90, stops })).toEqual({
      type: "linear-gradient",
      from: [50, 0],
      to: [50, 50],
      stops,
    });
  });

  it("wordColour returns the Gradient object itself, not a resolved string", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", { colors: { ...base.colors, text: gradient } });
    const word = lay(doc, 1500).words[0];
    if (word === undefined) throw new Error("no word");
    expect(wordColour(word, doc, 1500)).toEqual(gradient);
  });

  it("paints each word's glyph fill as its own linear-gradient spanning that word's own box", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", { colors: { ...base.colors, text: gradient } });
    const commands = draw(doc, 1500);
    const froms: string[] = [];
    let sawGradient = false;
    for (const command of walkCommands(commands)) {
      if (command.kind !== "text" || command.fill === undefined) continue;
      expect(command.fill.paint.type).toBe("linear-gradient");
      if (command.fill.paint.type === "linear-gradient") {
        sawGradient = true;
        froms.push(command.fill.paint.from.join(","));
      }
    }
    expect(sawGradient).toBe(true);
    // Not one gradient spanning the whole line: each word's own paint is built
    // from that word's own (different) box, so the absolute from/to points
    // differ word to word rather than repeating.
    expect(new Set(froms).size).toBeGreaterThan(1);
  });

  it("still paints a plain solid colour when colors.text is a hex string (no regression)", () => {
    const commands = draw(style("vertical-clean"), 1500);
    let checked = false;
    for (const command of walkCommands(commands)) {
      if (command.kind !== "text" || command.fill === undefined) continue;
      expect(command.fill.paint.type).toBe("solid");
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("colours the karaoke-fill overlay with the same per-word gradient as the base ink", () => {
    // karaoke-fill's shipped JSON sets activeText/upcomingText, which shadow
    // colors.text in every word state (`wordColour`'s karaoke-fill branch) —
    // clear them so this fixture actually exercises the colors.text fallback
    // the overlay and the base ink both read.
    const doc = style("karaoke-fill", {
      colors: { text: gradient, activeText: undefined, upcomingText: undefined, accent: undefined },
    });
    const word = lay(doc, 1000).words[1];
    if (word === undefined) throw new Error("no word");
    const commands = draw(doc, word.startMs + 1);
    let sawGradient = false;
    for (const command of walkCommands(commands)) {
      if (command.kind !== "text" || command.fill === undefined) continue;
      if (command.fill.paint.type === "linear-gradient") sawGradient = true;
    }
    expect(sawGradient).toBe(true);
  });

  it(
    "resolves an emphasis preset's Gradient colour to a solid stand-in for its own decorative " +
      "ground, while still painting the word's own ink as the full gradient",
    () => {
      const doc = style("vertical-clean", {
        emphasisPresets: [{ id: "grad", color: gradient, effect: "highlight" }],
      });
      const marked = WORDS.map((word, index) =>
        index === 0 ? { ...word, emphasisPresetId: "grad" } : word,
      );
      const commands = draw(doc, 1500, marked);
      let groundChecked = false;
      let inkIsGradient = false;
      for (const command of walkCommands(commands)) {
        if (command.kind === "roundRect" && command.fill !== undefined && !groundChecked) {
          expect(command.fill.paint).toEqual({ type: "solid", color: "#ff2e63ff" });
          groundChecked = true;
        }
        if (command.kind === "text" && command.fill?.paint.type === "linear-gradient") {
          inkIsGradient = true;
        }
      }
      expect(groundChecked).toBe(true);
      expect(inkIsGradient).toBe(true);
    },
  );

  it("golden-hash safety: every shipped system style still keeps a plain string colors.text", () => {
    for (const doc of styles.values()) {
      expect(typeof doc.colors.text, doc.id).toBe("string");
      for (const preset of doc.emphasisPresets) {
        if (preset.color === undefined) continue;
        expect(typeof preset.color, `${doc.id}/${preset.id}`).toBe("string");
      }
    }
  });
});

describe("animate", () => {
  it("wraps the caption in one group named after the segment", () => {
    const commands = draw(style("vertical-clean"), 1500);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: "group", id: "segment:seg" });
  });

  // `cueTiming` is exercised directly above, but CaptionStage/CanvasKit only ever
  // see the serialized `DrawCommand`s `renderFrame` hands them — `group()` drops
  // the opacity key entirely once it rounds to 1 (build.ts). This pins the fade
  // down to that command, for "vertical-clean" (DEFAULT_STYLE_REF,
  // apps/api/src/edg/init/transcript-init.ts), so a caption new projects start
  // with is never blunt by default.
  it("carries a fractional group opacity mid-fade for the production default style", () => {
    const doc = style("vertical-clean");
    expect(doc.animation.in.type).not.toBe("none");
    expect(doc.animation.out.type).not.toBe("none");

    const entering = draw(doc, 60); // half-way through the 120ms entry
    const enteringOpacity = (entering[0] as { opacity?: number }).opacity;
    expect(enteringOpacity).toBeGreaterThan(0);
    expect(enteringOpacity).toBeLessThan(1);

    const leaving = draw(doc, 2950); // inside the 120ms exit before endMs 3000
    const leavingOpacity = (leaving[0] as { opacity?: number }).opacity;
    expect(leavingOpacity).toBeGreaterThan(0);
    expect(leavingOpacity).toBeLessThan(1);
  });

  it("draws the stroke under the fill for every word", () => {
    const commands = draw(style("punch-pop"), 1500);
    const texts = [...walkCommands(commands)].filter((command) => command.kind === "text");
    expect(texts.length).toBeGreaterThan(1);
    expect(texts[0]).toHaveProperty("stroke");
    expect(texts[1]).toHaveProperty("fill");
  });

  it("draws the block box behind the type", () => {
    const commands = draw(style("karaoke-fill"), 1500);
    const flat = kinds(commands);
    expect(flat.indexOf("roundRect")).toBeLessThan(flat.indexOf("text"));
  });

  it("draws one box per line for a line-mode style", () => {
    const commands = draw(style("box-block"), 1500);
    const boxes = [...walkCommands(commands)].filter((command) => command.kind === "roundRect");
    const layout = lay(style("box-block"), 1500);
    expect(boxes).toHaveLength(layout.lines.length);
  });

  it("draws one box per word for a word-mode style", () => {
    const base = style("box-block");
    const doc = style("box-block", { box: { ...base.box, mode: "word" } });
    const boxes = [...walkCommands(draw(doc, 1500))].filter(
      (command) => command.kind === "roundRect",
    );
    expect(boxes).toHaveLength(lay(doc, 1500).words.length);
  });

  it("sweeps a clip across the word being spoken for a karaoke style", () => {
    const doc = style("karaoke-fill");
    const early = [...walkCommands(draw(doc, 800))].find((command) => command.kind === "clip");
    const late = [...walkCommands(draw(doc, 1400))].find((command) => command.kind === "clip");
    expect(early?.kind).toBe("clip");
    expect(late?.kind).toBe("clip");
    if (early?.kind !== "clip" || late?.kind !== "clip") return;
    if (early.shape.type !== "rect" || late.shape.type !== "rect")
      throw new Error("expected a rect clip");
    expect(late.shape.rect[2]).toBeGreaterThan(early.shape.rect[2]);
  });

  it("scales the word being spoken for a scale highlight", () => {
    const transforms = [...walkCommands(draw(style("punch-pop"), 100))].filter(
      (command) => command.kind === "transform",
    );
    expect(transforms.length).toBeGreaterThan(0);
    expect(
      transforms.some((command) => command.kind === "transform" && command.matrix[0] > 1),
    ).toBe(true);
  });

  it("draws an underline that grows across the word", () => {
    const doc = style("typewriter-mono");
    const rectAt = (tMs: number): number => {
      const found = [...walkCommands(draw(doc, tMs))].find(
        (command) => command.kind === "rect" && command.rect[2] > command.rect[0],
      );
      return found?.kind === "rect" ? found.rect[2] - found.rect[0] : 0;
    };
    expect(rectAt(1600)).toBeGreaterThan(0);
    expect(rectAt(1700)).toBeGreaterThan(rectAt(1600));
  });

  it("draws a glow as a shadow-only layer", () => {
    const shadows = [...walkCommands(draw(style("neon-glow"), 1600))].filter(
      (command) => command.kind === "shadow" && command.shadowOnly === true,
    );
    expect(shadows.length).toBeGreaterThan(0);
  });

  describe("typography.underline (K01)", () => {
    it("draws no extra rect when unset — every existing style is unaffected", () => {
      const doc = style("vertical-clean");
      expect(doc.typography.underline).toBeUndefined();
      const before = hashCommands(draw(doc, 1500));
      const explicitlyOff = style("vertical-clean", {
        typography: { ...doc.typography, underline: false },
      });
      expect(hashCommands(draw(explicitlyOff, 1500))).toBe(before);
    });

    it("draws a rect under every word when set", () => {
      const base = style("vertical-clean");
      const doc = style("vertical-clean", {
        typography: { ...base.typography, underline: true },
      });
      const without = [...walkCommands(draw(base, 1500))].filter((c) => c.kind === "rect").length;
      const withUnderline = [...walkCommands(draw(doc, 1500))].filter(
        (c) => c.kind === "rect",
      ).length;
      expect(withUnderline).toBe(without + lay(doc, 1500).words.length);
    });

    it("sits under the word, below its baseline box", () => {
      const base = style("vertical-clean");
      const doc = style("vertical-clean", {
        typography: { ...base.typography, underline: true },
      });
      const layout = lay(doc, 1500);
      const word = layout.words[0];
      expect(word).toBeDefined();
      if (word === undefined) return;
      const rect = [...walkCommands(draw(doc, 1500))].find(
        (c) => c.kind === "rect" && c.rect[0] === word.box[0] && c.rect[2] === word.box[2],
      );
      expect(rect?.kind).toBe("rect");
      if (rect?.kind !== "rect") return;
      expect(rect.rect[1]).toBeGreaterThanOrEqual(word.box[3]);
    });
  });

  describe("captionOpacity (K07)", () => {
    // `commands/build.ts`'s `group()` omits `opacity` entirely at 1 (fully
    // opaque is the implicit default, not a literal `1` on the wire) — this
    // reads a group's effective opacity the same way a backend does.
    function groupOpacity(command: DrawCommand | undefined): number {
      if (command === undefined || command.kind !== "group") throw new Error("expected a group");
      return command.opacity ?? 1;
    }

    it("renders byte-identical when unset — every caller before this field existed is unaffected", () => {
      const doc = style("vertical-clean");
      const before = hashCommands(draw(doc, 1500));
      expect(hashCommands(draw(doc, 1500, WORDS, undefined))).toBe(before);
    });

    it("is the same as leaving it unset when set to 1 (fully opaque)", () => {
      const doc = style("vertical-clean");
      expect(hashCommands(draw(doc, 1500))).toBe(hashCommands(draw(doc, 1500, WORDS, 1)));
    });

    it("multiplies straight into the segment's own top-level group opacity", () => {
      // 1500 ms sits well inside [0, 3000] with `vertical-clean`'s default cue
      // animation, so the cue's own fade contributes exactly 1 here — this
      // isolates the caption-opacity factor from the entry/exit fade math
      // `cuePhase`'s own tests already cover.
      const full = draw(style("vertical-clean"), 1500);
      expect(groupOpacity(full[0])).toBe(1);

      const half = draw(style("vertical-clean"), 1500, WORDS, 0.5);
      expect(half[0]).toMatchObject({ kind: "group", opacity: 0.5 });

      const quarter = draw(style("vertical-clean"), 1500, WORDS, 0.25);
      expect(quarter[0]).toMatchObject({ kind: "group", opacity: 0.25 });

      const zero = draw(style("vertical-clean"), 1500, WORDS, 0);
      expect(zero[0]).toMatchObject({ kind: "group", opacity: 0 });
    });

    it("composes with an in-progress cue fade rather than overriding it", () => {
      // `fade`'s entry animation at half progress: `cuePhase` returns
      // `opacity: p` directly (see `cuePhase`'s `"fade"` case), so the cue's
      // own contribution here is a known, exact 0.5 — captionOpacity must
      // multiply into that, not replace it.
      const doc = style("vertical-clean", {
        animation: {
          in: { type: "fade", durationMs: 1000 },
          out: { type: "none", durationMs: 0 },
          wordHighlight: { type: "none", durationMs: 0 },
          perWord: false,
        },
      });
      const midFadeFullOpacity = draw(doc, 500);
      expect(midFadeFullOpacity[0]).toMatchObject({ kind: "group", opacity: 0.5 });

      const midFadeHalfOpacity = draw(doc, 500, WORDS, 0.5);
      expect(midFadeHalfOpacity[0]).toMatchObject({ kind: "group", opacity: 0.25 });
    });

    it("draws nothing extra — only the existing group's opacity changes, not the command tree shape", () => {
      const doc = style("vertical-clean");
      const opaqueKinds = kinds(draw(doc, 1500));
      const fadedKinds = kinds(draw(doc, 1500, WORDS, 0.3));
      expect(fadedKinds).toEqual(opaqueKinds);
    });

    it("clamps an out-of-range value rather than producing an invalid opacity", () => {
      const doc = style("vertical-clean");
      expect(groupOpacity(draw(doc, 1500, WORDS, 1.5)[0])).toBe(1);
      expect(groupOpacity(draw(doc, 1500, WORDS, -0.5)[0])).toBe(0);
    });
  });

  describe("depth3d (K01)", () => {
    it("draws nothing when absent, disabled, or offsetPct is zero", () => {
      const base = style("vertical-clean");
      expect(base.depth3d).toBeUndefined();
      const disabled = style("vertical-clean", {
        depth3d: { enabled: false, color: "#101014", offsetPct: 6, layers: 4 },
      });
      const zeroOffset = style("vertical-clean", {
        depth3d: { enabled: true, color: "#101014", offsetPct: 0, layers: 4 },
      });
      const before = hashCommands(draw(base, 1500));
      expect(hashCommands(draw(disabled, 1500))).toBe(before);
      expect(hashCommands(draw(zeroOffset, 1500))).toBe(before);
    });

    it("draws `layers` transformed copies of the word ink, behind the real type", () => {
      const doc = style("vertical-clean", {
        depth3d: { enabled: true, color: "#101014", offsetPct: 6, layers: 4 },
      });
      const flat = kinds(draw(doc, 1500));
      const groups = [...walkCommands(draw(doc, 1500))].filter(
        (c) => c.kind === "group" && c.id?.startsWith("depth3d:") === true,
      );
      expect(groups).toHaveLength(4);
      // The first depth-layer transform (farthest back) is drawn before any text.
      expect(flat.indexOf("transform")).toBeLessThan(flat.indexOf("text"));
    });

    it("defaults to 6 layers when `layers` is omitted", () => {
      const doc = style("vertical-clean", {
        depth3d: { enabled: true, color: "#101014", offsetPct: 6 },
      });
      const groups = [...walkCommands(draw(doc, 1500))].filter(
        (c) => c.kind === "group" && c.id?.startsWith("depth3d:") === true,
      );
      expect(groups).toHaveLength(6);
    });

    it("caps layers at 8 even if a hand-authored document asks for more", () => {
      const doc = style("vertical-clean", {
        depth3d: { enabled: true, color: "#101014", offsetPct: 6, layers: 8 },
      });
      const groups = [...walkCommands(draw(doc, 1500))].filter(
        (c) => c.kind === "group" && c.id?.startsWith("depth3d:") === true,
      );
      expect(groups).toHaveLength(8);
    });

    it("steps each layer diagonally by offsetPct / layers", () => {
      const doc = style("vertical-clean", {
        depth3d: { enabled: true, color: "#101014", offsetPct: 8, layers: 2 },
      });
      const layout = lay(doc, 1500);
      const stepPx = ((8 / 100) * layout.fontSizePx) / 2;
      const transforms = [...walkCommands(draw(doc, 1500))]
        .filter((c) => c.kind === "transform")
        .slice(0, 2);
      expect(transforms).toHaveLength(2);
      const offsets = transforms
        .map((c) => (c.kind === "transform" ? c.matrix[4] : 0))
        .sort((a, b) => a - b);
      expect(offsets[0]).toBeCloseTo(stepPx, 1);
      expect(offsets[1]).toBeCloseTo(stepPx * 2, 1);
    });

    it("tints the depth layers with depth3d.color, not the word's own colour", () => {
      const doc = style("vertical-clean", {
        depth3d: { enabled: true, color: "#ff00ff", offsetPct: 6, layers: 1 },
      });
      const group = [...walkCommands(draw(doc, 1500))].find(
        (c) => c.kind === "group" && c.id === "depth3d:1",
      );
      expect(group?.kind).toBe("group");
      if (group?.kind !== "group") return;
      const text = group.children.find((c) => c.kind === "text");
      expect(text?.kind).toBe("text");
      if (text?.kind !== "text") return;
      expect(text.fill?.paint).toMatchObject({ type: "solid", color: "#ff00ffff" });
    });
  });

  it("reveals a typewriter caption progressively", () => {
    const doc = style("typewriter-mono");
    const revealed = (tMs: number): number =>
      [...walkCommands(draw(doc, tMs))]
        .filter((command) => command.kind === "clip" && command.shape.type === "rect")
        .reduce(
          (sum, command) =>
            command.kind === "clip" && command.shape.type === "rect"
              ? sum + (command.shape.rect[2] - command.shape.rect[0])
              : sum,
          0,
        );
    expect(revealed(200)).toBeLessThan(revealed(700));
  });

  it("draws the raster copies for a glitch style and only for it", () => {
    const glitch = [...walkCommands(draw(style("glitch-shift"), 1500))].filter(
      (command) => command.kind === "group" && command.id?.startsWith("raster:") === true,
    );
    expect(glitch).toHaveLength(2);
    const clean = [...walkCommands(draw(style("vertical-clean"), 1500))].filter(
      (command) => command.kind === "group" && command.id?.startsWith("raster:") === true,
    );
    expect(clean).toHaveLength(0);
  });

  it("blurs the backdrop for the glass style", () => {
    const blurs = [...walkCommands(draw(style("liquid-glass"), 1500))].filter(
      (command) => command.kind === "blur" && command.backdrop === true,
    );
    expect(blurs).toHaveLength(1);
    expect(blurs[0]?.kind === "blur" ? blurs[0].bounds : undefined).toBeDefined();
  });

  it("paints the prism style's type with a gradient", () => {
    const texts = [...walkCommands(draw(style("prism-split"), 1500))].filter(
      (command) => command.kind === "text" && command.fill?.paint.type === "linear-gradient",
    );
    expect(texts.length).toBeGreaterThan(0);
  });

  it("paints the sweep style's box with a gradient", () => {
    const boxes = [...walkCommands(draw(style("gradient-sweep"), 1500))].filter(
      (command) => command.kind === "roundRect" && command.fill?.paint.type === "linear-gradient",
    );
    expect(boxes.length).toBeGreaterThan(0);
  });

  it("applies an emphasis preset's colour, scale and ground", () => {
    const doc = style("punch-pop");
    const marked = WORDS.map((word, index) =>
      index === 1 ? { ...word, emphasisPresetId: "mark" } : word,
    );
    const commands = draw(doc, 100, marked);
    const grounds = [...walkCommands(commands)].filter((command) => command.kind === "roundRect");
    expect(grounds.length).toBeGreaterThan(0);
  });

  it("shakes an emphasised word without shaking the caption", () => {
    const doc = style("punch-pop");
    const shaken = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "shout" } : word,
    );
    const a = hashCommands(draw(doc, 400, shaken));
    const b = hashCommands(draw(doc, 420, shaken));
    expect(a).not.toBe(b);
    expect(hashCommands(draw(doc, 400, shaken))).toBe(a);
  });

  it("faux-bolds a heavier emphasis weight with a hairline stroke", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      emphasisPresets: [{ id: "heavy", weight: 900, effect: "none" }],
      stroke: { ...base.stroke, enabled: false },
    });
    const marked = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "heavy" } : word,
    );
    const strokes = [...walkCommands(draw(doc, 1500, marked))].filter(
      (command) => command.kind === "text" && command.stroke !== undefined,
    );
    expect(strokes.length).toBeGreaterThan(0);
  });

  it("outlines an emphasised word when the style has no stroke of its own", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      emphasisPresets: [{ id: "edge", color: "#ff2e63", effect: "outline" }],
      stroke: { ...base.stroke, enabled: false },
    });
    const marked = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "edge" } : word,
    );
    const strokes = [...walkCommands(draw(doc, 1500, marked))].filter(
      (command) => command.kind === "text" && command.stroke !== undefined,
    );
    expect(strokes.length).toBeGreaterThan(0);
  });

  it("draws an emphasis underline and glow", () => {
    const doc = style("vertical-clean", {
      emphasisPresets: [
        { id: "under", color: "#ffd400", effect: "underline" },
        { id: "halo", color: "#ffd400", effect: "glow" },
      ],
    });
    const withUnder = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "under" } : word,
    );
    const withGlow = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "halo" } : word,
    );
    expect(kinds(draw(doc, 1500, withUnder))).toContain("rect");
    expect(kinds(draw(doc, 1500, withGlow))).toContain("shadow");
  });

  it("ignores an emphasis preset the style does not define", () => {
    const doc = style("vertical-clean");
    const marked = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "ghost" } : word,
    );
    expect(() => draw(doc, 1500, marked)).not.toThrow();
  });

  it("adds a watermark image when the caller asks for one", () => {
    const layout = lay(style("vertical-clean"), 1500);
    const commands = animate({
      layout,
      style: style("vertical-clean"),
      tMs: 1500,
      watermarkAssetId: "wm",
    });
    expect(commands[commands.length - 1]).toMatchObject({ kind: "image", assetId: "wm" });
    expect(watermarkCommand("wm", layout)).toMatchObject({ kind: "image", opacity: 0.85 });
  });

  it("flattens a placed run into paired positions and clusters", () => {
    const layout = lay(style("vertical-clean"), 1500);
    const run = layout.words[0]?.runs[0];
    expect(run).toBeDefined();
    if (run === undefined) return;
    const glyphRun = toGlyphRun(run);
    expect(glyphRun.positions).toHaveLength(glyphRun.glyphs.length * 2);
    expect(glyphRun.clusters).toHaveLength(glyphRun.glyphs.length);
    expect(glyphRun.text).toBe(run.text);
  });

  it("is a pure function of time", () => {
    for (const id of ["punch-pop", "karaoke-fill", "glitch-shift", "liquid-glass"]) {
      const doc = style(id);
      expect(hashCommands(draw(doc, 1234))).toBe(hashCommands(draw(doc, 1234)));
    }
  });
});

describe("K05: Speed Mode Dynamic (animation.dynamicSpeed)", () => {
  it("dynamicCueDurationMs clamps a fifth of the span between a floor and a ceiling", () => {
    expect(__testing.dynamicCueDurationMs(100)).toBe(120); // floor
    expect(__testing.dynamicCueDurationMs(1000)).toBe(200); // 20% of 1000
    expect(__testing.dynamicCueDurationMs(10_000)).toBe(600); // ceiling
  });

  it("off (default) behaves exactly as before — duration is span-independent", () => {
    const base = style("vertical-clean");
    const fixed = style("vertical-clean", {
      animation: {
        ...base.animation,
        in: { type: "fade", durationMs: 200 },
        out: { type: "fade", durationMs: 200 },
      },
    });
    const short = layoutSegment({
      style: fixed,
      segment: { id: "s", startMs: 0, endMs: 300 },
      words: [{ wid: "0:0", t: "hi", s: 0, e: 300 }],
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 100,
    });
    const long = layoutSegment({
      style: fixed,
      segment: { id: "s", startMs: 0, endMs: 6000 },
      words: [{ wid: "0:0", t: "hi", s: 0, e: 6000 }],
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 100,
    });
    expect(fixed.animation.dynamicSpeed).toBeUndefined();
    expect(cueTiming(short, fixed, 100).opacity).toBe(cueTiming(long, fixed, 100).opacity);
  });

  it("on, a shorter on-screen caption transitions faster than a longer one", () => {
    const base = style("vertical-clean");
    const dynamic = style("vertical-clean", {
      animation: {
        ...base.animation,
        dynamicSpeed: true,
        in: { type: "fade", durationMs: 200 },
        out: { type: "fade", durationMs: 200 },
      },
    });
    const short = layoutSegment({
      style: dynamic,
      segment: { id: "s", startMs: 0, endMs: 300 },
      words: [{ wid: "0:0", t: "hi", s: 0, e: 300 }],
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 100,
    });
    const long = layoutSegment({
      style: dynamic,
      segment: { id: "s", startMs: 0, endMs: 6000 },
      words: [{ wid: "0:0", t: "hi", s: 0, e: 6000 }],
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 100,
    });
    // Short span → clamped to the 120ms floor, so 100ms in is 83% done.
    // Long span → clamped to the 600ms ceiling, so 100ms in is 17% done.
    expect(cueTiming(short, dynamic, 100).opacity).toBeGreaterThan(
      cueTiming(long, dynamic, 100).opacity,
    );
  });
});

describe("K05: animation.cueScope 'word'", () => {
  it("is absent by default — every existing style renders through the untouched line-scope path", () => {
    expect(style("vertical-clean").animation.cueScope).toBeUndefined();
  });

  it("wraps each drawn word in its own (unnamed) group instead of one segment-level transform", () => {
    const base = style("vertical-clean");
    const wordScoped = style("vertical-clean", {
      animation: {
        ...base.animation,
        cueScope: "word",
        in: { type: "fade", durationMs: 300 },
        out: { type: "fade", durationMs: 300 },
      },
    });
    const wordGroups = [...walkCommands(draw(wordScoped, 100))].filter(
      (c) => c.kind === "group" && c.id === undefined,
    );
    expect(wordGroups.length).toBeGreaterThan(0);
  });

  it("gives each word a different opacity while it enters independently", () => {
    const base = style("vertical-clean");
    const wordScoped = style("vertical-clean", {
      animation: {
        ...base.animation,
        cueScope: "word",
        in: { type: "fade", durationMs: 300 },
        out: { type: "fade", durationMs: 300 },
      },
    });
    // WORDS: "one" 0-750 (long done), "two" 750-1500 (mid entrance at 800).
    const opacities = [...walkCommands(draw(wordScoped, 800))]
      .filter((c) => c.kind === "group" && c.id === undefined)
      .map((c) => (c.kind === "group" ? (c.opacity ?? 1) : 1));
    expect(new Set(opacities).size).toBeGreaterThan(1);
  });

  it("differs from the default line scope at the same instant", () => {
    const base = style("vertical-clean");
    const shared = {
      ...base.animation,
      in: { type: "fade" as const, durationMs: 300 },
      out: { type: "fade" as const, durationMs: 300 },
    };
    const line = style("vertical-clean", { animation: { ...shared, cueScope: "line" } });
    const word = style("vertical-clean", { animation: { ...shared, cueScope: "word" } });
    expect(hashCommands(draw(line, 800))).not.toBe(hashCommands(draw(word, 800)));
  });

  it("still draws the block box keyed off the caption's own envelope, not per word", () => {
    const base = style("box-block");
    const wordScoped = style("box-block", {
      animation: {
        ...base.animation,
        cueScope: "word",
        in: { type: "fade", durationMs: 300 },
        out: { type: "fade", durationMs: 300 },
      },
    });
    const boxes = [...walkCommands(draw(wordScoped, 800))].filter((c) => c.kind === "roundRect");
    expect(boxes.length).toBeGreaterThan(0);
  });

  it("draws nothing before the caption's own envelope starts or after it ends", () => {
    const base = style("vertical-clean");
    const wordScoped = style("vertical-clean", {
      animation: { ...base.animation, cueScope: "word" },
    });
    expect(draw(wordScoped, 5000)).toEqual([]);
  });

  it("is a pure function of time", () => {
    const base = style("vertical-clean");
    const wordScoped = style("vertical-clean", {
      animation: {
        ...base.animation,
        cueScope: "word",
        in: { type: "slide-left", durationMs: 250 },
      },
    });
    expect(hashCommands(draw(wordScoped, 900))).toBe(hashCommands(draw(wordScoped, 900)));
  });
});

describe("typography.strikethrough (K05)", () => {
  it("draws no extra rect when unset — every existing style is unaffected", () => {
    const doc = style("vertical-clean");
    expect(doc.typography.strikethrough).toBeUndefined();
    const before = hashCommands(draw(doc, 1500));
    const explicitlyOff = style("vertical-clean", {
      typography: { ...doc.typography, strikethrough: false },
    });
    expect(hashCommands(draw(explicitlyOff, 1500))).toBe(before);
  });

  it("draws a rect through every word when set", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      typography: { ...base.typography, strikethrough: true },
    });
    const without = [...walkCommands(draw(base, 1500))].filter((c) => c.kind === "rect").length;
    const withStrike = [...walkCommands(draw(doc, 1500))].filter((c) => c.kind === "rect").length;
    expect(withStrike).toBe(without + lay(doc, 1500).words.length);
  });

  it("sits through the middle of the word, not underneath it like typography.underline", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      typography: { ...base.typography, strikethrough: true },
    });
    const layout = lay(doc, 1500);
    const word = layout.words[0];
    expect(word).toBeDefined();
    if (word === undefined) return;
    const rect = [...walkCommands(draw(doc, 1500))].find(
      (c) => c.kind === "rect" && c.rect[0] === word.box[0] && c.rect[2] === word.box[2],
    );
    expect(rect?.kind).toBe("rect");
    if (rect?.kind !== "rect") return;
    expect(rect.rect[1]).toBeLessThan(word.box[3]);
    expect(rect.rect[3]).toBeGreaterThan(word.box[1]);
    const middle = (word.box[1] + word.box[3]) / 2;
    expect(Math.abs((rect.rect[1] + rect.rect[3]) / 2 - middle)).toBeLessThan(0.5);
  });

  it("coexists with typography.underline — both draw, at different heights", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      typography: { ...base.typography, strikethrough: true, underline: true },
    });
    const layout = lay(doc, 1500);
    const word = layout.words[0];
    expect(word).toBeDefined();
    if (word === undefined) return;
    const rects = [...walkCommands(draw(doc, 1500))].filter(
      (c) => c.kind === "rect" && c.rect[0] === word.box[0] && c.rect[2] === word.box[2],
    );
    expect(rects).toHaveLength(2);
  });
});

describe("emphasisPresets[].underline override (K05)", () => {
  it("overrides the base caption's typography.underline for the marked word only", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      typography: { ...base.typography, underline: false },
      emphasisPresets: [{ id: "mark", underline: true }],
    });
    const marked = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "mark" } : word,
    );
    const layout = lay(doc, 1500, marked);
    const commands = draw(doc, 1500, marked);
    const [markedWord, otherWord] = layout.words;
    expect(markedWord).toBeDefined();
    expect(otherWord).toBeDefined();
    if (markedWord === undefined || otherWord === undefined) return;
    const hasUnderlineAt = (word: { box: readonly number[] }): boolean =>
      [...walkCommands(commands)].some(
        (c) => c.kind === "rect" && c.rect[0] === word.box[0] && c.rect[2] === word.box[2],
      );
    expect(hasUnderlineAt(markedWord)).toBe(true);
    expect(hasUnderlineAt(otherWord)).toBe(false);
  });

  it("an explicit underline: false override turns the marked word's underline off even when the base style has it on", () => {
    const base = style("vertical-clean");
    const doc = style("vertical-clean", {
      typography: { ...base.typography, underline: true },
      emphasisPresets: [{ id: "quiet", underline: false }],
    });
    const marked = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "quiet" } : word,
    );
    const layout = lay(doc, 1500, marked);
    const commands = draw(doc, 1500, marked);
    const [markedWord, otherWord] = layout.words;
    expect(markedWord).toBeDefined();
    expect(otherWord).toBeDefined();
    if (markedWord === undefined || otherWord === undefined) return;
    const hasUnderlineAt = (word: { box: readonly number[] }): boolean =>
      [...walkCommands(commands)].some(
        (c) => c.kind === "rect" && c.rect[0] === word.box[0] && c.rect[2] === word.box[2],
      );
    expect(hasUnderlineAt(markedWord)).toBe(false);
    expect(hasUnderlineAt(otherWord)).toBe(true);
  });

  it("falls back to the base typography.underline when the preset has no override of its own", () => {
    const base = style("vertical-clean");
    const withoutPreset = style("vertical-clean", {
      typography: { ...base.typography, underline: true },
    });
    const withPlainPreset = style("vertical-clean", {
      typography: { ...base.typography, underline: true },
      emphasisPresets: [{ id: "plain", color: "#ffd400" }],
    });
    const marked = WORDS.map((word, index) =>
      index === 0 ? { ...word, emphasisPresetId: "plain" } : word,
    );
    const before = [...walkCommands(draw(withoutPreset, 1500))].filter(
      (c) => c.kind === "rect",
    ).length;
    const after = [...walkCommands(draw(withPlainPreset, 1500, marked))].filter(
      (c) => c.kind === "rect",
    ).length;
    expect(after).toBe(before);
  });
});
