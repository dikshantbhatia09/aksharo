import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";
import { buildTimeMap, cutEdit } from "@montaj/timemap";

import { hashCommands } from "../commands/hash.js";
import { walkCommands } from "../commands/types.js";
import { RenderError } from "../errors.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";
import {
  type EdgProjection,
  type ProjectedSegment,
  visibleSegments,
  wordsBetween,
} from "./projection.js";
import { layoutFrame, renderFrame, watermarkFor } from "./render-frame.js";
import { mergeOverrides, resolveStyle, resolveWords, type TranscriptWord } from "./resolve.js";

const catalogue = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

const WORDS: TranscriptWord[] = [
  { wid: "0:0", s: 0, e: 500, t: "Bhai", sp: "sp1", scripts: { roman: "Bhai", native: "भाई" } },
  { wid: "0:1", s: 500, e: 1000, t: "aaj", sp: "sp1", scripts: { roman: "aaj", native: "आज" } },
  { wid: "0:2", s: 1000, e: 1500, t: "umm", sp: "sp1", filler: true },
  { wid: "0:3", s: 1500, e: 2000, t: "baat", sp: "sp1", scripts: { roman: "baat", native: "बात" } },
  { wid: "0:4", s: 2000, e: 2500, t: "gone", sp: "sp1", deleted: true },
  { wid: "0:5", s: 2500, e: 3000, t: "karenge", sp: "sp2" },
];

const SEGMENT: ProjectedSegment = {
  id: "seg-a",
  seq: "V",
  startWordId: "0:0",
  endWordId: "0:5",
  startMs: 0,
  endMs: 3000,
};

function projection(overrides: Partial<EdgProjection> = {}): EdgProjection {
  return {
    canvas: GOLDEN_CANVAS,
    styles: { defaultStyleId: "vertical-clean" },
    segments: [SEGMENT],
    words: WORDS,
    ...overrides,
  };
}

describe("mergeOverrides", () => {
  it("wins at every leaf and recurses into objects", () => {
    expect(mergeOverrides({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } })).toEqual({
      a: 1,
      b: { c: 9, d: 3 },
    });
  });

  it("replaces arrays rather than concatenating them", () => {
    expect(mergeOverrides({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it("ignores an undefined override and returns the base when there is nothing to merge", () => {
    const base = { a: 1 };
    expect(mergeOverrides(base, undefined)).toBe(base);
    expect(mergeOverrides(base, { a: undefined })).toEqual({ a: 1 });
  });

  it("lets a scalar override replace a scalar base", () => {
    expect(mergeOverrides(1 as unknown, { a: 2 })).toEqual({ a: 2 });
  });
});

describe("resolveStyle", () => {
  const source = { catalogue, defaultStyleId: "vertical-clean" };

  it("falls back to the document's default style", () => {
    expect(resolveStyle(source, {}).id).toBe("vertical-clean");
  });

  it("prefers the segment's own styleRef", () => {
    expect(resolveStyle(source, { styleRef: "punch-pop" }).id).toBe("punch-pop");
  });

  it("names the style it could not find", () => {
    expect(() => resolveStyle(source, { styleRef: "ghost" })).toThrow(RenderError);
    expect(() => resolveStyle(source, { styleRef: "ghost" })).toThrow(/not in the catalogue/);
  });

  it("applies document overrides from styles.inline.doc", () => {
    const resolved = resolveStyle(
      { ...source, documentOverrides: { typography: { sizePct: 9 } } },
      {},
    );
    expect(resolved.typography.sizePct).toBe(9);
    expect(resolved.typography.fontFamily).toBe(
      catalogue.get("vertical-clean")?.typography.fontFamily,
    );
  });

  it("lets the segment's own overrides beat the document's", () => {
    const resolved = resolveStyle(
      { ...source, documentOverrides: { typography: { sizePct: 9 } } },
      { overrides: { typography: { sizePct: 3 } } },
    );
    expect(resolved.typography.sizePct).toBe(3);
  });

  it("memoises a merged style so a 30 fps preview merges once", () => {
    const cache = new Map<string, StyleDoc>();
    const withOverrides = { ...source, documentOverrides: { typography: { sizePct: 9 } } };
    const first = resolveStyle(withOverrides, {}, cache);
    expect(resolveStyle(withOverrides, {}, cache)).toBe(first);
    expect(cache.size).toBe(1);
  });
});

describe("resolveWords", () => {
  const segment = { id: "seg-a", startMs: 0, endMs: 3000 };

  it("drops deleted words and, on request, fillers", () => {
    expect(resolveWords({ segment, words: WORDS, script: "roman" }).map((word) => word.t)).toEqual([
      "Bhai",
      "aaj",
      "umm",
      "baat",
      "karenge",
    ]);
    expect(
      resolveWords({ segment, words: WORDS, script: "roman", dropFillers: true }).map(
        (word) => word.t,
      ),
    ).toEqual(["Bhai", "aaj", "baat", "karenge"]);
  });

  it("shows the requested script, falling back to the stored text", () => {
    expect(resolveWords({ segment, words: WORDS, script: "native" }).map((word) => word.t)).toEqual(
      ["भाई", "आज", "umm", "बात", "karenge"],
    );
  });

  it("carries the speaker and the emphasis preset onto the word", () => {
    const resolved = resolveWords({
      segment: { ...segment, emphasis: [{ wordId: "0:1", presetId: "pop" }] },
      words: WORDS,
      script: "roman",
    });
    expect(resolved[1]?.emphasisPresetId).toBe("pop");
    expect(resolved[4]?.sp).toBe("sp2");
  });

  it("keeps word timings when a text override has the same number of tokens", () => {
    const resolved = resolveWords({
      segment: { ...segment, textOverrides: { en: "Brother today err talk we-will" } },
      words: WORDS,
      script: "en",
    });
    expect(resolved.map((word) => word.t)).toEqual(["Brother", "today", "err", "talk", "we-will"]);
    expect(resolved[0]?.s).toBe(0);
    expect(resolved[0]?.wid).toBe("0:0");
  });

  it("spreads the segment evenly when a text override changes the word count", () => {
    const resolved = resolveWords({
      segment: { ...segment, textOverrides: { en: "Brother we will talk today about editing" } },
      words: WORDS,
      script: "en",
    });
    expect(resolved).toHaveLength(7);
    expect(resolved[0]?.wid).toBe("seg-a#0");
    expect(resolved[0]?.s).toBe(0);
    expect(resolved[6]?.e).toBe(3000);
    expect(resolved[0]?.sp).toBe("sp1");
  });

  it("returns nothing for an override that is only whitespace", () => {
    expect(
      resolveWords({
        segment: { ...segment, textOverrides: { en: "   " } },
        words: WORDS,
        script: "en",
      }),
    ).toEqual([]);
  });
});

describe("segment selection", () => {
  const segments: ProjectedSegment[] = [
    { ...SEGMENT, id: "b", seq: "l", startMs: 1000, endMs: 2000 },
    { ...SEGMENT, id: "a", seq: "V", startMs: 0, endMs: 3000 },
    { ...SEGMENT, id: "c", seq: "t", startMs: 0, endMs: 3000, hidden: true },
  ];

  it("returns the segments on screen, in seq order", () => {
    expect(visibleSegments(segments, 1500).map((segment) => segment.id)).toEqual(["a", "b"]);
  });

  it("treats the end of a segment as exclusive", () => {
    expect(visibleSegments(segments, 2000).map((segment) => segment.id)).toEqual(["a"]);
    expect(visibleSegments(segments, 3000)).toEqual([]);
  });

  it("breaks a seq tie by id so the order is total", () => {
    const tied: ProjectedSegment[] = [
      { ...SEGMENT, id: "z", seq: "V" },
      { ...SEGMENT, id: "a", seq: "V" },
    ];
    expect(visibleSegments(tied, 100).map((segment) => segment.id)).toEqual(["a", "z"]);
  });

  it("slices the word list a segment covers", () => {
    expect(wordsBetween(WORDS, "0:1", "0:3").map((word) => word.wid)).toEqual([
      "0:1",
      "0:2",
      "0:3",
    ]);
    expect(wordsBetween(WORDS, "0:3", "9:9").map((word) => word.wid)).toEqual([
      "0:3",
      "0:4",
      "0:5",
    ]);
    expect(wordsBetween(WORDS, "9:9", "0:1")).toEqual([]);
  });
});

describe("renderFrame", () => {
  it("draws the caption that is on screen at the output instant", () => {
    const commands = renderFrame({
      projection: projection(),
      timemap: null,
      catalogue,
      registry,
      shaper,
      outputMs: 1500,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: "group", id: "segment:seg-a" });
  });

  it("draws nothing when no segment is on screen", () => {
    expect(
      renderFrame({
        projection: projection(),
        timemap: null,
        catalogue,
        registry,
        shaper,
        outputMs: 9000,
      }),
    ).toEqual([]);
  });

  it("maps the output clock back to the source clock through the timemap", () => {
    // Cut 0–1000 ms out: output 200 ms shows source 1200 ms.
    const timemap = buildTimeMap({ sourceDurationMs: 3000, edits: [cutEdit(0, 1000)] });
    expect(timemap.toSource(200)).toBe(1200);
    // A karaoke style is the honest probe: its commands depend on which word is
    // being sung, so a wrong clock shows up as a wrong frame.
    const common = {
      projection: projection({ styles: { defaultStyleId: "karaoke-fill" } }),
      catalogue,
      registry,
      shaper,
      outputMs: 200,
    };
    expect(layoutFrame({ ...common, timemap })).toHaveLength(1);
    // Output 200 ms is source 1200 ms: the caption is past its entry animation
    // and a different word is being spoken, so the frame is not the same frame.
    const mapped = renderFrame({ ...common, timemap });
    const unmapped = renderFrame({ ...common, timemap: null });
    expect(hashCommands(mapped)).not.toBe(hashCommands(unmapped));
    expect(hashCommands(mapped)).toBe(
      hashCommands(renderFrame({ ...common, timemap: null, outputMs: 1200 })),
    );
  });

  it("reads document-level overrides from styles.inline.doc", () => {
    const plain = layoutFrame({
      projection: projection(),
      timemap: null,
      catalogue,
      registry,
      shaper,
      outputMs: 1500,
    });
    const bigger = layoutFrame({
      projection: projection({
        styles: {
          defaultStyleId: "vertical-clean",
          inline: { doc: { typography: { sizePct: 8 } } },
        },
      }),
      timemap: null,
      catalogue,
      registry,
      shaper,
      outputMs: 1500,
    });
    expect(bigger[0]?.layout.fontSizePx).toBeGreaterThan(plain[0]?.layout.fontSizePx ?? 0);
  });

  it("previews at the proxy size when the caller overrides the canvas", () => {
    const layouts = layoutFrame({
      projection: projection(),
      timemap: null,
      catalogue,
      registry,
      shaper,
      outputMs: 1500,
      canvas: { width: 540, height: 960 },
    });
    expect(layouts[0]?.layout.canvas.height).toBe(960);
  });

  it("skips a segment whose words all vanished", () => {
    const empty = projection({
      segments: [{ ...SEGMENT, startWordId: "9:9", endWordId: "9:9" }],
    });
    expect(
      renderFrame({
        projection: empty,
        timemap: null,
        catalogue,
        registry,
        shaper,
        outputMs: 1500,
      }),
    ).toEqual([]);
  });

  it("burns in a watermark when the render manifest asks for one", () => {
    const commands = renderFrame({
      projection: projection({ render: { watermarkAssetId: "brand-mark" } }),
      timemap: null,
      catalogue,
      registry,
      shaper,
      outputMs: 1500,
    });
    const images = [...walkCommands(commands)].filter((command) => command.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ assetId: "brand-mark" });
  });

  it("keeps the watermark inside the frame", () => {
    const command = watermarkFor("wm", GOLDEN_CANVAS);
    expect(command.kind).toBe("image");
    if (command.kind !== "image") return;
    expect(command.dest[2]).toBeLessThan(GOLDEN_CANVAS.width);
    expect(command.dest[3]).toBeLessThan(GOLDEN_CANVAS.height);
  });

  it("colours a caption by speaker when the projection says who is talking", () => {
    const coloured = renderFrame({
      projection: projection({
        styles: { defaultStyleId: "podcast-duo" },
        speakerColours: { sp1: "#f2a541" },
      }),
      timemap: null,
      catalogue,
      registry,
      shaper,
      outputMs: 2900,
    });
    const fills = [...walkCommands(coloured)]
      .filter((command) => command.kind === "text")
      .map((command) => (command.kind === "text" ? command.fill?.paint : undefined))
      .filter((paint) => paint?.type === "solid")
      .map((paint) => (paint?.type === "solid" ? paint.color : ""));
    expect(fills).toContain("#f2a541ff");
  });
});
