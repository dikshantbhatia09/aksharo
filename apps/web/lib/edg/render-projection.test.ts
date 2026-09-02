import { describe, expect, it } from "vitest";

import { fromProjection } from "@montaj/edg";
import type { EdgHot, Pass, Segment, TranscriptChunk } from "@montaj/edg";

import { toRenderProjection } from "./render-projection";

function fixtureState() {
  const hot: EdgHot = {
    meta: { edgId: "e1", projectId: "p1", revision: 1, schemaVersion: 2 },
    media: [],
    transcript: { transcriptId: "t1", revision: 1, language: "en", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop", inline: { doc: { typography: { sizePct: 8 } } } },
  };
  const chunks: TranscriptChunk[] = [
    {
      chunkIdx: 0,
      startMs: 0,
      endMs: 2000,
      words: [
        { wid: "0:0", s: 0, e: 500, t: "hello", filler: true },
        { wid: "0:1", s: 500, e: 1000, t: "world" },
        { wid: "0:2", s: 1000, e: 1500, t: "gone", deleted: true },
      ],
    },
  ];
  const segments: Segment[] = [
    {
      id: "s1",
      seq: "V",
      startWordId: "0:0" as never,
      endWordId: "0:1" as never,
      startMs: 0,
      endMs: 1000,
      styleRef: "bold-drop",
      hidden: false,
    },
  ];
  const passes: Pass[] = [];
  return fromProjection({ ...hot, segments, passes }, { chunks });
}

describe("toRenderProjection", () => {
  it("carries the canvas, styles and render fields through unchanged", () => {
    const state = fixtureState();
    const projection = toRenderProjection(state);
    expect(projection.canvas).toEqual(state.hot.canvas);
    expect(projection.styles).toEqual(state.hot.styles);
  });

  it("maps segments to their ProjectedSegment shape, dropping empty optionals", () => {
    const projection = toRenderProjection(fixtureState());
    expect(projection.segments).toHaveLength(1);
    expect(projection.segments[0]).toMatchObject({
      id: "s1",
      seq: "V",
      startWordId: "0:0",
      endWordId: "0:1",
      styleRef: "bold-drop",
    });
    expect(projection.segments[0]).not.toHaveProperty("hidden");
  });

  it("carries only live words, in document order", () => {
    const projection = toRenderProjection(fixtureState());
    expect(projection.words.map((w) => w.wid)).toEqual(["0:0", "0:1"]);
  });

  it("carries the filler flag through for render-core's own dropFillers handling", () => {
    const projection = toRenderProjection(fixtureState());
    expect(projection.words[0]).toMatchObject({ wid: "0:0", filler: true });
    expect(projection.words[1]).not.toHaveProperty("filler");
  });
});
