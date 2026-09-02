import { describe, expect, it } from "vitest";

import { newId } from "@montaj/edg";

import {
  ItemsQueryDto,
  OpBatchRequestDto,
  ResegmentRequestDto,
  RevisionsQueryDto,
  SegmentsQueryDto,
} from "./edg.dto.js";
import { MAX_SEGMENT_PAGE_SIZE } from "./edg.errors.js";

const SEG = "01JCSEG00000000000000000AA";

function batch(count: number): unknown {
  const ops = Array.from({ length: count }, () => ({
    opId: newId(),
    type: "HideSegment",
    segmentId: SEG,
    hidden: true,
  }));
  return { baseRevision: 4, ops, clientOpIds: ops.map((op) => op.opId) };
}

describe("OpBatchRequestDto", () => {
  it("accepts the CONTRACTS §2 envelope", () => {
    const parsed = OpBatchRequestDto.zodSchema.parse(batch(3));
    expect(parsed.ops).toHaveLength(3);
    expect(parsed.baseRevision).toBe(4);
  });

  it("caps a batch at 500 ops", () => {
    // The cap is the schema's, not the controller's, so the browser client
    // enforces the identical limit before it sends.
    expect(OpBatchRequestDto.zodSchema.safeParse(batch(500)).success).toBe(true);
    expect(OpBatchRequestDto.zodSchema.safeParse(batch(501)).success).toBe(false);
  });

  it("refuses an empty batch and a negative base revision", () => {
    expect(OpBatchRequestDto.zodSchema.safeParse(batch(0)).success).toBe(false);
    expect(
      OpBatchRequestDto.zodSchema.safeParse({ ...(batch(1) as object), baseRevision: -1 }).success,
    ).toBe(false);
  });

  it("refuses an op the union does not know", () => {
    const opId = newId();
    expect(
      OpBatchRequestDto.zodSchema.safeParse({
        baseRevision: 1,
        ops: [{ opId, type: "DropEverything" }],
        clientOpIds: [opId],
      }).success,
    ).toBe(false);
  });
});

describe("ResegmentRequestDto", () => {
  it("takes the four limits without an opId — the server mints that", () => {
    const parsed = ResegmentRequestDto.zodSchema.parse({
      maxChars: 32,
      maxLines: 2,
      minMs: 700,
      maxMs: 6_000,
    });
    expect(parsed).toEqual({ maxChars: 32, maxLines: 2, minMs: 700, maxMs: 6_000 });
    expect("opId" in parsed).toBe(false);
  });

  it("keeps the op's own invariant that minMs <= maxMs", () => {
    expect(
      ResegmentRequestDto.zodSchema.safeParse({
        maxChars: 32,
        maxLines: 2,
        minMs: 9_000,
        maxMs: 6_000,
      }).success,
    ).toBe(false);
  });
});

describe("query DTOs", () => {
  it("coerces and bounds the segment page size", () => {
    expect(SegmentsQueryDto.zodSchema.parse({ limit: "250" }).limit).toBe(250);
    expect(
      SegmentsQueryDto.zodSchema.safeParse({ limit: String(MAX_SEGMENT_PAGE_SIZE + 1) }).success,
    ).toBe(false);
  });

  it("accepts an item state from the frozen enum only", () => {
    expect(ItemsQueryDto.zodSchema.parse({ state: "accepted" }).state).toBe("accepted");
    expect(ItemsQueryDto.zodSchema.safeParse({ state: "maybe" }).success).toBe(false);
  });

  it("coerces the revision cursor", () => {
    expect(RevisionsQueryDto.zodSchema.parse({ from: "12" }).from).toBe(12);
    expect(RevisionsQueryDto.zodSchema.safeParse({ from: "-1" }).success).toBe(false);
  });
});
