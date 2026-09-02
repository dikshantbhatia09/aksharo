import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { SegmentSchema, type Segment } from "@montaj/edg/schemas";

import {
  nextWordSeqOf,
  type PassItemRow,
  passItemColumns,
  type SegmentRow,
  segmentColumns,
  toChunk,
  toHot,
  toPassItem,
  toSegment,
} from "./edg.rows.js";

const SEG = "01JCSEG00000000000000000AA";
const ITEM = "01JCITEM0000000000000000AA";
const PASS = "01JCPASS0000000000000000AA";

function row(overrides: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: SEG,
    seq: "V",
    startWordId: "0:0",
    endWordId: "0:5",
    startMs: 0,
    endMs: 1_200,
    styleRef: null,
    textOverrides: {},
    emphasis: [],
    position: null,
    overrides: null,
    hidden: false,
    updatedAtRev: 4,
    deletedAtRev: null,
    ...overrides,
  };
}

describe("toSegment", () => {
  it("drops empty optionals rather than turning them into nulls", () => {
    const segment = toSegment(row());

    // `toProjection` is canonical: a `position: null` key would make two clients
    // that applied the same ops serialise different bytes.
    expect(Object.keys(segment).sort()).toEqual([
      "endMs",
      "endWordId",
      "id",
      "seq",
      "startMs",
      "startWordId",
    ]);
    expect(SegmentSchema.parse(segment)).toEqual(segment);
  });

  it("carries the optionals that are set", () => {
    const segment = toSegment(
      row({
        styleRef: "punch-pop",
        textOverrides: { roman: "kya baat hai" },
        emphasis: [{ wordId: "0:2", presetId: "pop" }],
        position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
        overrides: { fontSize: 64 },
        hidden: true,
      }),
    );

    expect(segment).toMatchObject({
      styleRef: "punch-pop",
      textOverrides: { roman: "kya baat hai" },
      emphasis: [{ wordId: "0:2", presetId: "pop" }],
      position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
      overrides: { fontSize: 64 },
      hidden: true,
    });
    expect(SegmentSchema.parse(segment)).toEqual(segment);
  });

  it("round-trips through the write columns", () => {
    const before = toSegment(row({ styleRef: "clean-bold", hidden: true }));
    const columns = segmentColumns(before, 9);

    const after = toSegment(
      row({
        ...columns,
        textOverrides: columns.textOverrides as Prisma.JsonValue,
        emphasis: columns.emphasis as Prisma.JsonValue,
        position: null,
        overrides: null,
      }),
    );

    expect(after).toEqual(before);
  });

  it("writes SQL NULL, not JSON null, for an absent position", () => {
    const columns = segmentColumns(toSegment(row()), 1);
    expect(columns.position).toBe(Prisma.DbNull);
    expect(columns.overrides).toBe(Prisma.DbNull);
    expect(columns.deletedAtRev).toBeNull();
  });
});

describe("toPassItem", () => {
  const item: PassItemRow = {
    id: ITEM,
    passId: PASS,
    kind: "cut",
    startMs: 1_000,
    endMs: 2_000,
    payload: {},
    keyframesRef: null,
    confidence: 0.8,
    reason: "silence",
    state: "proposed",
    licenceSnapshot: null,
  };

  it("maps the row onto the frozen PassItem", () => {
    expect(toPassItem(item)).toEqual({
      itemId: ITEM,
      passId: PASS,
      kind: "cut",
      startMs: 1_000,
      endMs: 2_000,
      payload: {},
      confidence: 0.8,
      reason: "silence",
      state: "proposed",
    });
  });

  it("keeps a keyframe reference the worker set", () => {
    const withRef = toPassItem({ ...item, kind: "cut", keyframesRef: "kf/01JC.bin" });
    expect(withRef.keyframesRef).toBe("kf/01JC.bin");
    expect(passItemColumns(withRef).keyframesRef).toBe("kf/01JC.bin");
  });
});

describe("toChunk and nextWordSeqOf", () => {
  it("reads the words out of the JSONB column", () => {
    const chunk = toChunk({
      id: "01JCCHUNK000000000000000AA",
      transcriptId: "01JCTR000000000000000000AA",
      revision: 1,
      chunkIdx: 0,
      startMs: 0,
      endMs: 600_000,
      words: [{ wid: "0:0", s: 0, e: 100, t: "hi" }] as unknown as Prisma.JsonValue,
      nextWordSeq: 1,
    });

    expect(chunk).toEqual({
      chunkIdx: 0,
      startMs: 0,
      endMs: 600_000,
      words: [{ wid: "0:0", s: 0, e: 100, t: "hi" }],
    });
  });

  it("never lowers next_word_seq: ids are allocated from it and never reused", () => {
    const chunk = {
      chunkIdx: 0,
      startMs: 0,
      endMs: 10,
      words: [{ wid: "0:3", s: 0, e: 1, t: "a" }],
    };
    expect(nextWordSeqOf(chunk as never, 2)).toBe(4);
    expect(nextWordSeqOf(chunk as never, 90)).toBe(90);
  });
});

describe("toHot", () => {
  it("rejects a document that is not an EdgHot", () => {
    expect(() => toHot({ meta: {} } as unknown as Prisma.JsonValue)).toThrow();
  });

  it("accepts the shape CONTRACTS §2 freezes", () => {
    const hot = {
      meta: {
        edgId: "01JCEDG00000000000000000AA",
        projectId: "01JCPRJ00000000000000000AA",
        revision: 3,
        schemaVersion: 2,
      },
      media: [],
      transcript: {
        transcriptId: "01JCTR000000000000000000AA",
        revision: 1,
        language: "hi-Latn",
        scripts: ["roman"],
      },
      canvas: { aspect: "9:16", width: 1080, height: 1920 },
      styles: { defaultStyleId: "clean-bold" },
    };

    expect(toHot(hot as unknown as Prisma.JsonValue).meta.revision).toBe(3);
  });
});

describe("segment ordering", () => {
  it('uses byte order, which is what `seq COLLATE "C"` gives ORDER BY', () => {
    const keys: Segment["seq"][] = ["1", "1B", "2", "Zz", "a", "zzzV"];
    expect([...keys].sort()).toEqual(keys);
  });
});
