import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, StyleDocSchema, type StyleDoc } from "@montaj/caption-styles";

import { hashCommands } from "../commands/hash.js";
import { walkCommands } from "../commands/types.js";
import { layoutSegment } from "../layout/layout.js";
import { typographyKeyword, typographyWordBounds } from "../layout/typography-motion.js";
import { createFixtureRenderer } from "../testing.js";
import { animate } from "./animate.js";
import { revealTypographyWord } from "./typography-motion.js";

import type { Shaper } from "../fonts/shaper.js";
import type { FontRegistry } from "../fonts/types.js";
import type { RenderWord } from "../layout/types.js";

const styles = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;
beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});
const IDS = ["editorial-keyword-zoom", "editorial-stack", "editorial-ghost-type"];
const words = (texts = ["Make", "your", "captions", "feel", "alive"]): RenderWord[] =>
  texts.map((t, i) => ({ wid: `0:${i}`, t, s: i * 500, e: (i + 1) * 500 }));
function style(id: string): StyleDoc {
  const doc = styles.get(id);
  if (doc === undefined) throw new Error(`Missing ${id}`);
  return doc;
}
function lay(doc: StyleDoc, tMs = 1600, text = words(), width = 720, height = 1280) {
  return layoutSegment({
    style: doc,
    words: text,
    segment: { id: "typography", startMs: 0, endMs: 3000 },
    canvas: { width, height },
    registry,
    shaper,
    tMs,
  });
}

describe("speech-timed editorial typography", () => {
  it.each(IDS)(
    "%s shapes the keyword in the display face and keeps supporting serif text",
    (id) => {
      const doc = style(id);
      const layout = lay(doc);
      const keyword = typographyKeyword(layout, doc);
      expect(keyword?.text).toBe("captions");
      expect(keyword?.runs[0]?.fontId).toContain("anton");
      expect(layout.words[0]?.runs[0]?.fontId).toContain("playfair");
      expect(keyword?.runs[0]?.fontSizePx).toBeGreaterThan(
        layout.words[1]?.runs[0]?.fontSizePx ?? 0,
      );
      expect(layout.words.map((word) => word.wid)).toEqual(words().map((word) => word.wid));
    },
  );

  it("keeps an explicitly chosen keyword when it is shorter than another word", () => {
    const doc = style(IDS[0] ?? "");
    const text = words().map((word, i) =>
      i === 0 ? { ...word, emphasisPresetId: "keyword" } : word,
    );
    expect(typographyKeyword(lay(doc, 1600, text), doc)?.text).toBe("Make");
  });

  it.each(IDS)(
    "%s fits portrait, landscape and square frames, including long and Indic text",
    (id) => {
      const doc = style(id);
      for (const [width, height] of [
        [720, 1280],
        [1280, 720],
        [720, 720],
      ] as const) {
        for (const texts of [
          ["Supercalifragilisticexpialidocious", "make", "beautiful", "captions"],
          ["आपके", "कैप्शन", "ऐसे", "दिखेंगे"],
          ["உங்கள்", "வசனங்கள்", "இப்படி", "இருக்கும்"],
          ["Solo"],
        ]) {
          const layout = lay(doc, 1600, words(texts), width, height);
          for (const word of layout.words) {
            const box = typographyWordBounds(word);
            expect(box[0]).toBeGreaterThanOrEqual(-0.01);
            expect(box[1]).toBeGreaterThanOrEqual(-0.01);
            expect(box[2]).toBeLessThanOrEqual(width + 0.01);
            expect(box[3]).toBeLessThanOrEqual(height + 0.01);
            expect(word.runs.every((run) => run.glyphs.length > 0)).toBe(true);
          }
        }
      }
    },
  );

  it.each(IDS)("%s renders identical commands after arbitrary forward/backward seeks", (id) => {
    const doc = style(id);
    const render = (tMs: number) => animate({ style: doc, layout: lay(doc, tMs), tMs });
    const expected = hashCommands(render(1120));
    for (const time of [2800, 400, 2200, 0, 1600]) render(time);
    expect(hashCommands(render(1120))).toBe(expected);
    expect(hashCommands(render(1080))).not.toBe(expected);
    expect(render(-1)).toEqual([]);
    expect(render(3000)).toEqual([]);
  });

  it("reveals complete shaped clusters without splitting Hindi marks", () => {
    const doc = style(IDS[0] ?? "");
    const word = lay(doc, 1000, words(["कैप्शन"])).words[0];
    expect(word).toBeDefined();
    if (word === undefined) return;
    expect(revealTypographyWord(word, 0).runs.flatMap((run) => run.glyphs)).toHaveLength(0);
    for (const amount of [0.1, 0.3, 0.5, 0.7]) {
      const partial = revealTypographyWord(word, amount);
      partial.runs.forEach((run, i) => {
        const original = word.runs.at(i);
        for (const cluster of new Set(run.glyphs.map((glyph) => glyph.cluster))) {
          expect(run.glyphs.filter((glyph) => glyph.cluster === cluster)).toEqual(
            original?.glyphs.filter((glyph) => glyph.cluster === cluster),
          );
        }
      });
    }
    expect(revealTypographyWord(word, 1)).toBe(word);
  });

  it("finishes every word's reveal after its duration, including captions later in a video", () => {
    const doc = style("editorial-stack");
    const text = words().map((word) => ({ ...word, s: word.s + 10_000, e: word.e + 10_000 }));
    const layout = layoutSegment({
      style: doc,
      words: text,
      registry,
      shaper,
      segment: { id: "later", startMs: 10_000, endMs: 13_000 },
      canvas: { width: 720, height: 1280 },
      tMs: 12_600,
    });
    const ink = [...walkCommands(animate({ style: doc, layout, tMs: 12_600 }))].filter(
      (command) => command.kind === "text",
    );
    expect(ink.reduce((count, command) => count + command.run.glyphs.length, 0)).toBe(
      layout.words
        .flatMap((word) => word.runs)
        .reduce((count, run) => count + run.glyphs.length, 0),
    );
  });

  it("does not reveal future foreground words in the zoom treatment", () => {
    const doc = style(IDS[0] ?? "");
    const commands = [...walkCommands(animate({ style: doc, layout: lay(doc, 700), tMs: 700 }))];
    const ids = commands.filter((command) => command.kind === "group").map((command) => command.id);
    expect(ids).toContain("typography:word:0:1");
    expect(ids).not.toContain("typography:word:0:2");
    expect(ids).toContain("typography:ghost");
  });

  it("draws the vertical stack word and can disable the ghost independently", () => {
    const stack = style("editorial-stack");
    expect(lay(stack).words[0]?.rotationDeg).toBe(-90);
    const base = style("editorial-ghost-type");
    const doc = StyleDocSchema.parse({
      ...base,
      animation: {
        ...base.animation,
        typographyMotion: { ...base.animation.typographyMotion, ghostOpacity: 0 },
      },
    });
    const commands = [...walkCommands(animate({ style: doc, layout: lay(doc), tMs: 1600 }))];
    expect(
      commands.some((command) => command.kind === "group" && command.id === "typography:ghost"),
    ).toBe(false);
  });

  it("keeps motion when saved under a custom preset id and serialised", () => {
    const original = style("editorial-stack");
    const saved = StyleDocSchema.parse(
      JSON.parse(JSON.stringify({ ...original, id: "my-editorial-preset" })),
    );
    expect(hashCommands(animate({ style: saved, layout: lay(saved), tMs: 1600 }))).toBe(
      hashCommands(animate({ style: original, layout: lay(original), tMs: 1600 })),
    );
  });
});
