import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildWordIndex } from "../transcript-index.js";
import { validateProjection } from "../validate.js";
import { EDG_SCHEMA_VERSION, EdgHotSchema, EdgProjectionSchema } from "./document.js";
import { PassItemSchema, PassSchema } from "./pass.js";
import { SeqKeySchema, UlidSchema, WordIdSchema } from "./primitives.js";
import { SegmentSchema } from "./segment.js";
import { TranscriptChunkSchema, TranscriptManifestSchema, WordSchema } from "./transcript.js";

const FIXTURES = join(__dirname, "..", "..", "fixtures");
const sampleProject: unknown = JSON.parse(
  readFileSync(join(FIXTURES, "sample-project.json"), "utf8"),
);
const sampleTranscript: unknown = JSON.parse(
  readFileSync(join(FIXTURES, "sample-transcript.json"), "utf8"),
);

describe("primitives", () => {
  it("accepts and rejects ULIDs", () => {
    expect(UlidSchema.safeParse("01KF0FV49Y5XZB11BZX5QKS937").success).toBe(true);
    expect(UlidSchema.safeParse("01KF0FV49Y5XZB11BZX5QKS93").success).toBe(false);
    expect(UlidSchema.safeParse("01kf0fv49y5xzb11bzx5qks937").success).toBe(false);
  });

  it("accepts and rejects word ids", () => {
    expect(WordIdSchema.safeParse("12:345").success).toBe(true);
    expect(WordIdSchema.safeParse("12:").success).toBe(false);
    expect(WordIdSchema.safeParse("a:1").success).toBe(false);
  });

  it("accepts and rejects fractional keys", () => {
    expect(SeqKeySchema.safeParse("1B").success).toBe(true);
    expect(SeqKeySchema.safeParse("1B0").success).toBe(false);
    expect(SeqKeySchema.safeParse("").success).toBe(false);
  });
});

describe("transcript schemas", () => {
  it("parses the sample transcript and its manifest", () => {
    const parsed = TranscriptManifestSchema.parse(
      (sampleTranscript as { manifest: unknown }).manifest,
    );
    const chunks = (sampleTranscript as { chunks: unknown[] }).chunks.map((chunk) =>
      TranscriptChunkSchema.parse(chunk),
    );
    expect(parsed.language).toBe("hi-Latn");
    expect(parsed.chunks[0]?.wordCount).toBe(chunks[0]?.words.length);
    expect(parsed.chunks[0]?.nextWordSeq).toBe(chunks[0]?.words.length);
  });

  it("carries per-script text and filler flags", () => {
    const word = WordSchema.parse({
      wid: "0:0",
      s: 320,
      e: 700,
      t: "Matlab",
      c: 0.91,
      sp: "sp1",
      scripts: { roman: "Matlab", native: "मतलब" },
      filler: true,
    });
    expect(word.scripts?.native).toBe("मतलब");
    expect(word.filler).toBe(true);
  });

  it("rejects a word that belongs to another chunk", () => {
    const result = TranscriptChunkSchema.safeParse({
      chunkIdx: 1,
      startMs: 0,
      endMs: 10,
      words: [{ wid: "0:0", s: 0, e: 5, t: "nope" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/does not belong to chunk 1/);
  });

  it("reports a malformed word id once", () => {
    const result = TranscriptChunkSchema.safeParse({
      chunkIdx: 0,
      startMs: 0,
      endMs: 10,
      words: [{ wid: "zero", s: 0, e: 5, t: "nope" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });
});

describe("segment schema", () => {
  it("keeps overrides, emphasis and position", () => {
    const segment = SegmentSchema.parse({
      id: "01KF0FV49Y5XZB11BZX5QKS937",
      seq: "V",
      startWordId: "0:0",
      endWordId: "0:4",
      startMs: 0,
      endMs: 1_000,
      styleRef: "punch-pop",
      textOverrides: { en: "Hello" },
      emphasis: [{ wordId: "0:2", presetId: "pop" }],
      position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
      overrides: { fontSizePct: 7.5 },
      hidden: false,
    });
    expect(segment.emphasis?.[0]?.presetId).toBe("pop");
    expect(segment.overrides?.["fontSizePct"]).toBe(7.5);
  });

  it("rejects a non-fractional seq", () => {
    expect(
      SegmentSchema.safeParse({
        id: "01KF0FV49Y5XZB11BZX5QKS937",
        seq: 1,
        startWordId: "0:0",
        endWordId: "0:4",
        startMs: 0,
        endMs: 1_000,
      }).success,
    ).toBe(false);
  });
});

describe("pass item payloads", () => {
  const base = {
    itemId: "01KF0FV49Y5XZB11BZX5QKS937",
    passId: "01KF0FV4E7G8APCCPA8G2Y4MEJ",
    startMs: 0,
    endMs: 1_000,
    state: "proposed" as const,
  };

  it("parses every kind", () => {
    const kinds = [
      { ...base, kind: "cut", payload: {} },
      {
        ...base,
        kind: "zoom",
        payload: {
          target: { x: 0.2, y: 0.1, w: 0.5, h: 0.5 },
          scaleFrom: 1,
          scaleTo: 1.4,
          easing: "velocity",
          keyframesRef: "kf-1",
        },
      },
      { ...base, kind: "reframe", payload: { aspect: "9:16", keyframesRef: "kf-2" } },
      {
        ...base,
        kind: "sfx",
        payload: {
          assetId: base.itemId,
          packId: "fixture-pack",
          startMs: 0,
          durationMs: 600,
          gainDb: -3,
          fadeInMs: 0,
          fadeOutMs: 0,
          duck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
          licenceSnapshot: { provider: "owned" },
          cueReason: "energy-peak → impact",
        },
      },
      {
        ...base,
        kind: "music",
        payload: {
          assetId: base.itemId,
          packId: "fixture-pack",
          startMs: 0,
          durationMs: 1_000,
          gainDb: -8,
          loopPolicy: "loop",
          bedDuck: { depthDb: -12, attackMs: 500, releaseMs: 900 },
          licenceSnapshot: { provider: "owned" },
          mood: ["upbeat"],
          bpm: 120,
        },
      },
      {
        ...base,
        kind: "title",
        payload: {
          text: "Aaj ka topic",
          styleRef: "hype-bold",
          position: { x: 0.5, y: 0.2, anchor: "center" },
          animIn: "pop",
          animOut: "fade",
        },
      },
    ];
    for (const item of kinds) {
      expect(PassItemSchema.parse(item)).toEqual(item);
    }
  });

  it("rejects a payload from the wrong kind", () => {
    expect(
      PassItemSchema.safeParse({ ...base, kind: "cut", payload: { assetId: base.itemId } }).success,
    ).toBe(
      true, // unknown keys are stripped: an empty cut payload stays empty
    );
    expect(
      PassItemSchema.safeParse({
        ...base,
        kind: "zoom",
        payload: { aspect: "9:16", keyframesRef: "kf" },
      }).success,
    ).toBe(false);
    expect(PassItemSchema.safeParse({ ...base, kind: "nudge", payload: {} }).success).toBe(false);
  });

  it("keeps a zoom rectangle inside the frame", () => {
    expect(
      PassItemSchema.safeParse({
        ...base,
        kind: "zoom",
        payload: {
          target: { x: 0.2, y: 0.1, w: 1.4, h: 0.5 },
          scaleFrom: 1,
          scaleTo: 1.4,
          easing: "velocity",
        },
      }).success,
    ).toBe(false);
  });

  it("requires a known pass status", () => {
    expect(
      PassSchema.safeParse({
        passId: base.passId,
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "finished",
        items: [],
      }).success,
    ).toBe(false);
  });
});

describe("sample-project.json", () => {
  const projection = EdgProjectionSchema.parse(sampleProject);

  it("is a 90-second, 3-speaker Hinglish project with 12 segments", () => {
    expect(projection.meta.schemaVersion).toBe(EDG_SCHEMA_VERSION);
    expect(projection.media[0]?.durationMs).toBe(90_000);
    expect(projection.transcript.language).toBe("hi-Latn");
    expect(projection.transcript.speakers).toHaveLength(3);
    expect(projection.segments).toHaveLength(12);
    expect(projection.canvas.aspect).toBe("9:16");
  });

  it("carries one autocut pass with four items and one zoom item", () => {
    const autocut = projection.passes.find((pass) => pass.type === "autocut");
    expect(autocut?.items).toHaveLength(4);
    expect(autocut?.items.every((item) => item.kind === "cut")).toBe(true);
    const zooms = projection.passes
      .flatMap((pass) => pass.items)
      .filter((item) => item.kind === "zoom");
    expect(zooms).toHaveLength(1);
    expect(zooms[0]?.payload).toMatchObject({ easing: "velocity", scaleTo: 1.35 });
  });

  it("passes every projection invariant against its transcript", () => {
    const chunks = (sampleTranscript as { chunks: unknown[] }).chunks.map((chunk) =>
      TranscriptChunkSchema.parse(chunk),
    );
    expect(validateProjection(projection, { wordIndex: buildWordIndex(chunks) })).toEqual([]);
  });

  it("is also a valid hot document once the rows are dropped", () => {
    const { segments: _segments, passes: _passes, ...hot } = projection;
    expect(EdgHotSchema.parse(hot).meta.revision).toBe(projection.meta.revision);
  });
});
