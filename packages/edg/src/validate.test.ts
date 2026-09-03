import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createUlidFactory, makeWordId, type WordId } from "./ids.js";
import { type EdgProjection } from "./schemas/document.js";
import { type TranscriptChunk } from "./schemas/transcript.js";
import { seqSequence } from "./seq.js";
import { buildWordIndex } from "./transcript-index.js";
import { assertValidProjection, ProjectionInvalidError, validateProjection } from "./validate.js";

/** Deterministic ids keep failures reproducible. */
function ids(): () => string {
  let tick = 0;
  return createUlidFactory({
    now: () => 1_766_000_000_000 + tick,
    randomDigits: () => {
      tick += 1;
      return Array.from({ length: 16 }, (_, i) => (tick * 13 + i * 7) % 32);
    },
  });
}

interface Spec {
  /** Words per segment. */
  spans: number[];
}

function build(spec: Spec): { projection: EdgProjection; chunks: TranscriptChunk[] } {
  const newId = ids();
  const words: TranscriptChunk["words"] = [];
  const seqs = seqSequence(spec.spans.length);
  const segments: EdgProjection["segments"] = [];
  let n = 0;

  for (const [index, span] of spec.spans.entries()) {
    const first = n;
    for (let i = 0; i < span; i += 1) {
      words.push({ wid: makeWordId(0, n), s: n * 500, e: n * 500 + 400, t: `w${n}` });
      n += 1;
    }
    segments.push({
      id: newId(),
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      seq: seqs[index] as string,
      startWordId: makeWordId(0, first),
      endWordId: makeWordId(0, n - 1),
      startMs: first * 500,
      endMs: (n - 1) * 500 + 400,
      emphasis: [{ wordId: makeWordId(0, first), presetId: "pop" }],
    });
  }

  const chunks: TranscriptChunk[] = [{ chunkIdx: 0, startMs: 0, endMs: 600_000, words }];
  const projection: EdgProjection = {
    meta: { edgId: newId(), projectId: newId(), revision: 1, schemaVersion: 2 },
    media: [{ mediaId: newId(), role: "primary", durationMs: n * 500 + 1_000 }],
    transcript: { transcriptId: newId(), revision: 1, language: "hi-Latn", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
    segments,
    passes: [],
  };
  return { projection, chunks };
}

const base = build({ spans: [3, 4, 2] });
const index = buildWordIndex(base.chunks);

/** A deep copy that keeps the projection type. */
function clone(projection: EdgProjection): EdgProjection {
  return JSON.parse(JSON.stringify(projection)) as EdgProjection;
}

describe("validateProjection", () => {
  it("accepts a well-formed projection", () => {
    expect(validateProjection(base.projection, { wordIndex: index })).toEqual([]);
    expect(assertValidProjection(base.projection, { wordIndex: index })).toMatchObject({
      meta: { schemaVersion: 2 },
    });
  });

  it("reports schema failures and stops there", () => {
    const issues = validateProjection({ meta: { schemaVersion: 3 } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.code === "schema")).toBe(true);
    expect(validateProjection(undefined)[0]).toMatchObject({ code: "schema", path: "$" });
  });

  it("checks segments without a transcript when no index is supplied", () => {
    const projection = clone(base.projection);
    (projection.segments[0] as { startWordId: WordId }).startWordId = "0:99";
    expect(validateProjection(projection)).toEqual([]);
    expect(validateProjection(projection, { wordIndex: index })).toEqual([
      expect.objectContaining({ code: "unknown-word", path: "segments[0].startWordId" }),
    ]);
  });

  it("catches duplicate ids and duplicate seqs", () => {
    const projection = clone(base.projection);
    projection.segments[1] = { ...(projection.segments[1] as EdgProjection["segments"][number]) };
    (projection.segments[1] as { id: string }).id = projection.segments[0]?.id ?? "";
    (projection.segments[1] as { seq: string }).seq = projection.segments[0]?.seq ?? "";
    const codes = validateProjection(projection, { wordIndex: index }).map((issue) => issue.code);
    expect(codes).toContain("duplicate-id");
    expect(codes).toContain("duplicate-seq");
    expect(codes).toContain("segment-order");
  });

  it("catches segments out of seq order", () => {
    const projection = clone(base.projection);
    const [first, second] = [projection.segments[0], projection.segments[1]];
    projection.segments[0] = second as EdgProjection["segments"][number];
    projection.segments[1] = first as EdgProjection["segments"][number];
    expect(
      validateProjection(projection, { wordIndex: index }).map((issue) => issue.code),
    ).toContain("segment-order");
  });

  it("catches backwards times and backwards word ranges", () => {
    const projection = clone(base.projection);
    const segment = projection.segments[0] as EdgProjection["segments"][number];
    segment.startMs = 9_000;
    segment.endMs = 10;
    const swap = segment.startWordId;
    segment.startWordId = segment.endWordId;
    segment.endWordId = swap;
    const codes = validateProjection(projection, { wordIndex: index }).map((issue) => issue.code);
    expect(codes).toContain("time-order");
    expect(codes).toContain("word-order");
  });

  it("catches emphasis outside the segment and on unknown words", () => {
    const projection = clone(base.projection);
    const segment = projection.segments[0] as EdgProjection["segments"][number];
    segment.emphasis = [
      { wordId: "0:6", presetId: "pop" },
      { wordId: "0:404", presetId: "pop" },
    ];
    const issues = validateProjection(projection, { wordIndex: index });
    expect(issues.map((issue) => issue.code)).toEqual(["emphasis-out-of-range", "unknown-word"]);
  });

  it("catches pass and item problems", () => {
    const projection = clone(base.projection);
    const newId = ids();
    const passId = newId();
    const itemId = newId();
    projection.passes = [
      {
        passId,
        type: "reframe",
        engine: "punch-zoom@1",
        params: {},
        status: "ready",
        items: [
          {
            itemId,
            passId,
            kind: "zoom",
            startMs: 5_000,
            endMs: 1_000,
            keyframesRef: "kf-a",
            payload: {
              target: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
              scaleFrom: 1,
              scaleTo: 1.4,
              easing: "easeInOut",
              keyframesRef: "kf-b",
            },
            state: "proposed",
          },
          {
            itemId,
            passId: newId(),
            kind: "cut",
            startMs: 0,
            endMs: 100,
            payload: {},
            state: "proposed",
          },
        ],
      },
      {
        passId,
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "queued",
        items: [],
      },
    ];
    const codes = validateProjection(projection, { wordIndex: index }).map((issue) => issue.code);
    expect(codes).toContain("time-order");
    expect(codes).toContain("keyframes-ref-mismatch");
    expect(codes).toContain("item-pass-mismatch");
    expect(codes.filter((code) => code === "duplicate-id")).toHaveLength(2); // pass and item
  });

  it("throws with every issue attached", () => {
    const projection = clone(base.projection);
    (projection.segments[1] as { endMs: number }).endMs = 0;
    expect(() => assertValidProjection(projection, { wordIndex: index })).toThrow(
      ProjectionInvalidError,
    );
    try {
      assertValidProjection(projection, { wordIndex: index });
    } catch (error) {
      expect((error as ProjectionInvalidError).issues[0]?.code).toBe("time-order");
      expect((error as ProjectionInvalidError).message).toMatch(/segments\[1\]\.endMs/);
    }
  });
});

describe("validateProjection properties", () => {
  const spans = fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 12 });

  it("accepts every generated document", () => {
    fc.assert(
      fc.property(spans, (sizes) => {
        const { projection, chunks } = build({ spans: sizes });
        expect(validateProjection(projection, { wordIndex: buildWordIndex(chunks) })).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it("rejects a document whose segments were reordered", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 2, maxLength: 8 }),
        (sizes) => {
          const { projection, chunks } = build({ spans: sizes });
          const reordered = clone(projection);
          reordered.segments.reverse();
          const issues = validateProjection(reordered, { wordIndex: buildWordIndex(chunks) });
          expect(issues.some((issue) => issue.code === "segment-order")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
