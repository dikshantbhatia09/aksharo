import { describe, expect, it } from "vitest";

import type { EdgProjection, TranscriptChunk } from "@montaj/edg/schemas";

import { buildRenderProjection } from "./projection.js";

const EDG_ID = "01JA20EDG00000000000000000";
const PROJECT_ID = "01JA20PRJECT00000000000000";
const TRANSCRIPT_ID = "01JA20TRANSCRPT00000000000";

function baseEdg(overrides: Partial<EdgProjection> = {}): EdgProjection {
  return {
    meta: { edgId: EDG_ID, projectId: PROJECT_ID, revision: 3, schemaVersion: 2 },
    media: [],
    transcript: {
      transcriptId: TRANSCRIPT_ID,
      revision: 1,
      language: "hi-Latn",
      scripts: ["roman"],
      speakers: [
        { id: "s1", name: "A", color: "#ff0000" },
        { id: "s2", name: "B" },
      ],
    },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "vertical-clean" },
    segments: [],
    passes: [],
    ...overrides,
  } as EdgProjection;
}

describe("buildRenderProjection", () => {
  it("maps canvas dimensions straight through", () => {
    const projection = buildRenderProjection(baseEdg(), []);
    expect(projection.canvas).toEqual({ width: 1080, height: 1920 });
  });

  it("maps every documented segment field, and omits absent optionals", () => {
    const edg = baseEdg({
      segments: [
        {
          id: "seg1",
          seq: "n",
          startWordId: "0:0",
          endWordId: "0:1",
          startMs: 0,
          endMs: 800,
          styleRef: "punch-pop",
          textOverrides: { roman: "hi there" },
          emphasis: [{ wordId: "0:0", presetId: "pulse" }],
          hidden: false,
          position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
        },
      ],
    });

    const projection = buildRenderProjection(edg, []);
    expect(projection.segments).toHaveLength(1);
    expect(projection.segments[0]).toEqual({
      id: "seg1",
      seq: "n",
      startMs: 0,
      endMs: 800,
      startWordId: "0:0",
      endWordId: "0:1",
      styleRef: "punch-pop",
      textOverrides: { roman: "hi there" },
      emphasis: [{ wordId: "0:0", presetId: "pulse" }],
      hidden: false,
      position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
    });
  });

  it("drops undefined optional segment fields rather than writing them as undefined", () => {
    const edg = baseEdg({
      segments: [
        {
          id: "seg1",
          seq: "n",
          startWordId: "0:0",
          endWordId: "0:0",
          startMs: 0,
          endMs: 400,
        },
      ],
    });
    const projection = buildRenderProjection(edg, []);
    expect(Object.keys(projection.segments[0] as object).sort()).toEqual(
      ["endMs", "endWordId", "id", "seq", "startMs", "startWordId"].sort(),
    );
  });

  it("flattens every chunk's words in order", () => {
    const chunks: TranscriptChunk[] = [
      { chunkIdx: 0, startMs: 0, endMs: 800, words: [{ wid: "0:0", s: 0, e: 400, t: "yaar" }] },
      {
        chunkIdx: 1,
        startMs: 800,
        endMs: 1_600,
        words: [{ wid: "1:0", s: 800, e: 1_200, t: "chalo" }],
      },
    ];
    const projection = buildRenderProjection(baseEdg(), chunks);
    expect(projection.words.map((word) => word.wid)).toEqual(["0:0", "1:0"]);
    expect(projection.words[0]).toEqual({ wid: "0:0", s: 0, e: 400, t: "yaar" });
  });

  it("carries filler, deleted and scripts through when present", () => {
    const chunks: TranscriptChunk[] = [
      {
        chunkIdx: 0,
        startMs: 0,
        endMs: 400,
        words: [
          {
            wid: "0:0",
            s: 0,
            e: 400,
            t: "matlab",
            filler: true,
            deleted: false,
            sp: "s1",
            scripts: { native: "मतलब" },
          },
        ],
      },
    ];
    const projection = buildRenderProjection(baseEdg(), chunks);
    expect(projection.words[0]).toEqual({
      wid: "0:0",
      s: 0,
      e: 400,
      t: "matlab",
      sp: "s1",
      filler: true,
      deleted: false,
      scripts: { native: "मतलब" },
    });
  });

  it("builds speakerColours only from speakers that carry a colour", () => {
    const projection = buildRenderProjection(baseEdg(), []);
    expect(projection.speakerColours).toEqual({ s1: "#ff0000" });
  });

  it("omits speakerColours entirely when no speaker has a colour", () => {
    const edg = baseEdg({
      transcript: {
        transcriptId: TRANSCRIPT_ID,
        revision: 1,
        language: "en",
        scripts: ["roman"],
        speakers: [{ id: "s1" }],
      },
    });
    const projection = buildRenderProjection(edg, []);
    expect(projection.speakerColours).toBeUndefined();
  });

  it("omits speakerColours when there are no speakers at all", () => {
    const edg = baseEdg({
      transcript: { transcriptId: TRANSCRIPT_ID, revision: 1, language: "en", scripts: ["roman"] },
    });
    const projection = buildRenderProjection(edg, []);
    expect(projection.speakerColours).toBeUndefined();
  });
});
