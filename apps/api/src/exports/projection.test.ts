import { describe, expect, it } from "vitest";

import type { EdgProjection, TranscriptChunk } from "@montaj/edg/schemas";

import { buildRenderProjection, overlayImageIds } from "./projection.js";

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

  it("carries the hook title, and adds no overlays key to a document without one", () => {
    const hook = {
      id: "01JHOOK0000000000000000000",
      kind: "hook-title" as const,
      text: "Paisa bachana easy hai",
      startMs: 0,
      endMs: 2_500,
    };
    expect(buildRenderProjection(baseEdg({ overlays: [hook] }), []).overlays).toEqual([hook]);
    expect(buildRenderProjection(baseEdg(), [])).not.toHaveProperty("overlays");
  });

  describe("a brand kit's overlays (2026-10-02)", () => {
    const KEPT = "01JKEPT0000000000000000000";
    const GONE = "01JG0NE0000000000000000000";
    const image = (assetId: string) => ({
      assetId,
      format: "webp" as const,
      width: 512,
      height: 256,
    });
    const logo = (assetId: string) => ({
      id: `01JL0G0${assetId.slice(7)}`,
      kind: "logo" as const,
      startMs: 0,
      endMs: 30_000,
      image: image(assetId),
      corner: "top-right" as const,
      sizePct: 16,
      opacity: 0.9,
      marginPct: 4,
    });
    const card = (assetId: string, words = true) => ({
      id: "01JCRD00000000000000000000",
      kind: "end-card" as const,
      startMs: 27_000,
      endMs: 30_000,
      ...(words ? { cta: "Follow for more" } : {}),
      background: "#141217",
      image: image(assetId),
    });
    const styledHook = {
      id: "01JHQQK0000000000000000000",
      kind: "hook-title" as const,
      text: "Paisa bachana easy hai",
      startMs: 0,
      endMs: 2_500,
      appearance: { background: "#f0508a" },
    };

    it("names every logo the document draws, once", () => {
      expect(overlayImageIds(baseEdg({ overlays: [logo(KEPT), card(KEPT), styledHook] }))).toEqual([
        KEPT,
      ]);
      expect(overlayImageIds(baseEdg())).toEqual([]);
    });

    it("passes them as stored, the hook title's look included", () => {
      const overlays = [styledHook, logo(KEPT), card(KEPT)];
      expect(buildRenderProjection(baseEdg({ overlays }), []).overlays).toEqual(overlays);
    });

    it("leaves out a logo the workspace no longer keeps, and draws an end card without it", () => {
      const images = new Set([KEPT]);
      const projection = buildRenderProjection(
        baseEdg({ overlays: [logo(KEPT), logo(GONE), card(GONE)] }),
        [],
        { images },
      );
      expect(projection.overlays?.map((overlay) => overlay.kind)).toEqual(["logo", "end-card"]);
      expect(projection.overlays?.[1]).not.toHaveProperty("image");
      // A card that was only its logo is left out altogether.
      expect(
        buildRenderProjection(baseEdg({ overlays: [card(GONE, false)] }), [], { images }),
      ).not.toHaveProperty("overlays");
    });
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
