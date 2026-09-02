import { describe, expect, it } from "vitest";

import { type EdgOp, type OpRejectionReason } from "../schemas/ops.js";
import { idFactory } from "../testing.js";
import { rebaseOps } from "./rebase.js";

const nextOpId = idFactory(700_000);
const nextSegmentId = idFactory(1_000);

function op<T extends EdgOp["type"]>(
  type: T,
  fields: Omit<Extract<EdgOp, { type: T }>, "type" | "opId">,
): EdgOp {
  return { opId: nextOpId(), type, ...fields } as EdgOp;
}

const A = nextSegmentId();
const B = nextSegmentId();
const C = nextSegmentId();
const AB = nextSegmentId();
const ABC = nextSegmentId();

function reasons(rejected: { reason: OpRejectionReason }[]): OpRejectionReason[] {
  return rejected.map((rejection) => rejection.reason);
}

describe("last writer wins per (segment, field)", () => {
  it("drops an incoming write to a scalar field a later revision already wrote", () => {
    const incoming = [op("HideSegment", { segmentId: A, hidden: true })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("HideSegment", { segmentId: A, hidden: false }),
    ]);
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["rebased-away"]);
  });

  it("raises a conflict rather than dropping a caption text somebody else rewrote", () => {
    const incoming = [op("SetSegmentText", { segmentId: A, script: "en", text: "mine" })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("SetSegmentText", { segmentId: A, script: "en", text: "theirs" }),
    ]);
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["conflict"]);
    expect(rejected[0]?.message).toContain("en");
  });

  it("only conflicts on the script that was rewritten", () => {
    const since = [op("SetSegmentText", { segmentId: A, script: "en", text: "theirs" })];
    const other = rebaseOps(
      [op("SetSegmentText", { segmentId: A, script: "native", text: "mine" })],
      since,
    );
    expect(other.rebased).toHaveLength(1);
    expect(other.rejected).toEqual([]);
    const elsewhere = rebaseOps(
      [op("SetSegmentText", { segmentId: B, script: "en", text: "mine" })],
      since,
    );
    expect(elsewhere.rebased).toHaveLength(1);
  });

  it("prefers stale over conflict when the segment itself is gone", () => {
    const { rejected } = rebaseOps(
      [op("SetSegmentText", { segmentId: A, script: "en", text: "mine" })],
      [
        op("SetSegmentText", { segmentId: A, script: "en", text: "theirs" }),
        op("MergeSegments", { segmentIds: [A, B], newSegmentId: AB }),
      ],
    );
    expect(reasons(rejected)).toEqual(["stale"]);
  });

  it("keeps a write to another script, another field or another segment", () => {
    const incoming = [
      op("SetSegmentText", { segmentId: A, script: "native", text: "mine" }),
      op("HideSegment", { segmentId: A, hidden: true }),
      op("SetSegmentText", { segmentId: B, script: "en", text: "mine" }),
    ];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("SetSegmentText", { segmentId: A, script: "en", text: "theirs" }),
    ]);
    expect(rebased).toEqual(incoming);
    expect(rejected).toEqual([]);
  });

  it("treats emphasis as one field per word", () => {
    const since = [op("SetEmphasis", { segmentId: A, wordId: "0:3", presetId: "pop" })];
    const same = rebaseOps(
      [op("SetEmphasis", { segmentId: A, wordId: "0:3", presetId: null })],
      since,
    );
    expect(reasons(same.rejected)).toEqual(["rebased-away"]);
    const other = rebaseOps(
      [op("SetEmphasis", { segmentId: A, wordId: "0:4", presetId: "pop" })],
      since,
    );
    expect(other.rebased).toHaveLength(1);
  });

  it("drops a second Resegment, a repeated MergePass and a repeated SetRender", () => {
    const passId = nextSegmentId();
    const since = [
      op("Resegment", { maxChars: 24, maxLines: 2, minMs: 700, maxMs: 6000 }),
      op("SetRender", { presets: ["social"] }),
      op("MergePass", {
        pass: {
          passId,
          type: "autocut",
          engine: "autocut@2",
          params: {},
          status: "merged",
          items: [],
        },
      }),
    ];
    const { rebased, rejected } = rebaseOps(
      [
        op("Resegment", { maxChars: 32, maxLines: 2, minMs: 700, maxMs: 5000 }),
        op("SetRender", { presets: ["broadcast"] }),
        op("MergePass", {
          pass: {
            passId,
            type: "autocut",
            engine: "autocut@2",
            params: {},
            status: "merged",
            items: [],
          },
        }),
      ],
      since,
    );
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["rebased-away", "rebased-away", "rebased-away"]);
  });
});

describe("segments merged away since the base revision", () => {
  const since = [op("MergeSegments", { segmentIds: [A, B], newSegmentId: AB })];

  it("remaps the ops that still mean something onto the merged segment", () => {
    const { rebased, rejected } = rebaseOps(
      [
        op("SetEmphasis", { segmentId: A, wordId: "0:1", presetId: "pop" }),
        op("SetSegmentPosition", { segmentId: B, position: null }),
        op("HideSegment", { segmentId: A, hidden: true }),
        op("SetStyle", { scope: "segment", segmentId: B, styleRef: "punch-pop" }),
        op("SplitSegment", { segmentId: A, atWordId: "0:2", newSegmentId: C }),
      ],
      since,
    );
    expect(rejected).toEqual([]);
    expect(rebased.map((entry) => (entry as { segmentId: string }).segmentId)).toEqual([
      AB,
      AB,
      AB,
      AB,
      AB,
    ]);
  });

  it("marks text and bounds edits stale, because the merged line is a different line", () => {
    const { rebased, rejected } = rebaseOps(
      [
        op("SetSegmentText", { segmentId: A, script: "en", text: "mine" }),
        op("SetSegmentBounds", { segmentId: B, startMs: 0, endMs: 900 }),
      ],
      since,
    );
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["stale", "stale"]);
  });

  it("follows a chain of merges to the segment that exists now", () => {
    const { rebased } = rebaseOps(
      [op("HideSegment", { segmentId: A, hidden: true })],
      [
        op("MergeSegments", { segmentIds: [A, B], newSegmentId: AB }),
        op("MergeSegments", { segmentIds: [AB, C], newSegmentId: ABC }),
      ],
    );
    expect((rebased[0] as { segmentId: string } | undefined)?.segmentId).toBe(ABC);
  });

  it("rewrites a merge list and drops it when there is nothing left to join", () => {
    const both = rebaseOps([op("MergeSegments", { segmentIds: [A, B], newSegmentId: C })], since);
    expect(reasons(both.rejected)).toEqual(["rebased-away"]);

    const partial = rebaseOps(
      [op("MergeSegments", { segmentIds: [B, C], newSegmentId: nextSegmentId() })],
      since,
    );
    expect((partial.rebased[0] as { segmentIds: string[] } | undefined)?.segmentIds).toEqual([
      AB,
      C,
    ]);
  });
});

describe("segments split since the base revision", () => {
  it("grows a merge list with the children, so the ids are neighbours again", () => {
    const D = nextSegmentId();
    const { rebased } = rebaseOps(
      [op("MergeSegments", { segmentIds: [A, B], newSegmentId: nextSegmentId() })],
      [
        op("SplitSegment", { segmentId: A, atWordId: "0:2", newSegmentId: C }),
        op("SplitSegment", { segmentId: A, atWordId: "0:1", newSegmentId: D }),
      ],
    );
    // A was split twice: D sits between A and C, and all four are now neighbours.
    expect((rebased[0] as { segmentIds: string[] } | undefined)?.segmentIds).toEqual([A, D, C, B]);
  });

  it("drops a bounds edit on the segment the split already reshaped", () => {
    const { rejected } = rebaseOps(
      [op("SetSegmentBounds", { segmentId: A, startMs: 0, endMs: 900 })],
      [op("SplitSegment", { segmentId: A, atWordId: "0:2", newSegmentId: C })],
    );
    expect(reasons(rejected)).toEqual(["rebased-away"]);
  });
});

describe("words changed since the base revision", () => {
  it("marks every op that names a deleted word stale", () => {
    const since = [op("DeleteWord", { wordId: "0:3" })];
    const { rebased, rejected } = rebaseOps(
      [
        op("SetEmphasis", { segmentId: A, wordId: "0:3", presetId: "pop" }),
        op("EditWord", { wordId: "0:3", text: "x" }),
        op("DeleteWord", { wordId: "0:3" }),
        op("InsertWordAfter", { wordId: "0:3", newWordId: "0:90", text: "x", s: 1, e: 2 }),
        op("SetSegmentBounds", { segmentId: A, startMs: 0, endMs: 9, endWordId: "0:3" }),
        op("SplitSegment", { segmentId: A, atWordId: "0:3", newSegmentId: nextSegmentId() }),
        op("SetWordTiming", { wordId: "0:3", s: 1, e: 2 }),
      ],
      since,
    );
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual([
      "stale",
      "stale",
      "stale",
      "stale",
      "stale",
      "stale",
      "stale",
    ]);
  });

  it("turns a concurrent edit of the same word into a conflict", () => {
    const since = [op("EditWord", { wordId: "0:3", text: "theirs" })];
    const { rebased, rejected } = rebaseOps(
      [
        op("EditWord", { wordId: "0:3", text: "mine" }),
        op("EditWord", { wordId: "0:4", text: "mine" }),
      ],
      since,
    );
    expect(reasons(rejected)).toEqual(["conflict"]);
    expect(rebased).toHaveLength(1);
  });
});

describe("Resegment since the base revision", () => {
  const since = [op("Resegment", { maxChars: 24, maxLines: 2, minMs: 700, maxMs: 6000 })];

  it("invalidates every segment-addressed op", () => {
    const { rebased, rejected } = rebaseOps(
      [
        op("SetSegmentText", { segmentId: A, script: "en", text: "x" }),
        op("SetSegmentBounds", { segmentId: A, startMs: 0, endMs: 1 }),
        op("SplitSegment", { segmentId: A, atWordId: "0:2", newSegmentId: C }),
        op("MergeSegments", { segmentIds: [A, B], newSegmentId: C }),
        op("SetEmphasis", { segmentId: A, wordId: "0:1", presetId: "pop" }),
        op("SetSegmentPosition", { segmentId: A, position: null }),
        op("HideSegment", { segmentId: A, hidden: true }),
        op("SetStyle", { scope: "segment", segmentId: A, styleRef: "punch-pop" }),
      ],
      since,
    );
    expect(rebased).toEqual([]);
    expect(new Set(reasons(rejected))).toEqual(new Set(["stale-after-resegment"]));
  });

  it("keeps word-level and document-level ops", () => {
    const incoming = [
      op("EditWord", { wordId: "0:1", text: "x" }),
      op("DeleteWord", { wordId: "0:2" }),
      op("InsertWordAfter", { wordId: "0:1", newWordId: "0:90", text: "x", s: 1, e: 2 }),
      op("SetStyle", { scope: "doc", styleRef: "punch-pop" }),
      op("SetAudio", { clean: { enabled: true } }),
      op("SetWordTiming", { wordId: "0:4", s: 10, e: 20 }),
      op("SetProtectedRanges", { ranges: [{ id: "a", s: 1_000, e: 2_000 }] }),
    ];
    const { rebased, rejected } = rebaseOps(incoming, since);
    expect(rebased).toEqual(incoming);
    expect(rejected).toEqual([]);
  });
});

describe("SetProtectedRanges", () => {
  it("last write wins on doc:protected", () => {
    const incoming = [op("SetProtectedRanges", { ranges: [{ id: "a", s: 1_000, e: 2_000 }] })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("SetProtectedRanges", { ranges: [{ id: "b", s: 3_000, e: 4_000 }] }),
    ]);
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["rebased-away"]);
  });

  it("survives a Resegment since the base (it names no segment or word)", () => {
    const incoming = [op("SetProtectedRanges", { ranges: [{ id: "a", s: 1_000, e: 2_000 }] })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("Resegment", { maxChars: 30, maxLines: 2, minMs: 700, maxMs: 6000 }),
    ]);
    expect(rebased).toEqual(incoming);
    expect(rejected).toEqual([]);
  });
});

describe("SetWordTiming", () => {
  it("last write wins on the same word's timing field", () => {
    const incoming = [op("SetWordTiming", { wordId: "0:3", s: 10, e: 20 })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("SetWordTiming", { wordId: "0:3", s: 30, e: 40 }),
    ]);
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["rebased-away"]);
  });

  it("keeps a SetWordTiming on a different word", () => {
    const incoming = [op("SetWordTiming", { wordId: "0:4", s: 10, e: 20 })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("SetWordTiming", { wordId: "0:3", s: 30, e: 40 }),
    ]);
    expect(rebased).toEqual(incoming);
    expect(rejected).toEqual([]);
  });

  it("goes stale after DeleteWord of that word", () => {
    const incoming = [op("SetWordTiming", { wordId: "0:3", s: 10, e: 20 })];
    const { rebased, rejected } = rebaseOps(incoming, [op("DeleteWord", { wordId: "0:3" })]);
    expect(rebased).toEqual([]);
    expect(reasons(rejected)).toEqual(["stale"]);
  });

  it("survives a Resegment since the base — it is a word-level op", () => {
    const incoming = [op("SetWordTiming", { wordId: "0:3", s: 10, e: 20 })];
    const { rebased, rejected } = rebaseOps(incoming, [
      op("Resegment", { maxChars: 24, maxLines: 2, minMs: 700, maxMs: 6000 }),
    ]);
    expect(rebased).toEqual(incoming);
    expect(rejected).toEqual([]);
  });
});

describe("ops that lose only part of themselves", () => {
  it("narrows DecideItems to the proposals nobody has decided", () => {
    const items = [nextSegmentId(), nextSegmentId(), nextSegmentId()];
    const { rebased, rejected } = rebaseOps(
      [op("DecideItems", { itemIds: items, state: "accepted" })],
      [op("DecideItems", { itemIds: [items[0] ?? ""], state: "rejected" })],
    );
    expect(rejected).toEqual([]);
    expect((rebased[0] as { itemIds: string[] } | undefined)?.itemIds).toEqual(items.slice(1));
  });

  it("drops DecideItems once every proposal is decided", () => {
    const itemId = nextSegmentId();
    const { rejected } = rebaseOps(
      [op("DecideItems", { itemIds: [itemId], state: "accepted" })],
      [op("DecideItems", { itemIds: [itemId], state: "rejected" })],
    );
    expect(reasons(rejected)).toEqual(["rebased-away"]);
  });

  it("narrows SetAudio to the half nobody has set", () => {
    const { rebased, rejected } = rebaseOps(
      [op("SetAudio", { clean: { enabled: true }, ducking: { enabled: true } })],
      [op("SetAudio", { clean: { enabled: false } })],
    );
    expect(rejected).toEqual([]);
    expect(rebased[0]).toMatchObject({ clean: undefined, ducking: { enabled: true } });
  });

  it("drops SetAudio when both halves are already set", () => {
    const { rejected } = rebaseOps(
      [op("SetAudio", { clean: { enabled: true }, ducking: { enabled: true } })],
      [op("SetAudio", { clean: { enabled: false }, ducking: { enabled: false } })],
    );
    expect(reasons(rejected)).toEqual(["rebased-away"]);
  });
});

describe("an empty op log", () => {
  it("returns the batch untouched", () => {
    const incoming = [
      op("HideSegment", { segmentId: A, hidden: true }),
      op("EditWord", { wordId: "0:1", text: "x" }),
      op("SetStyle", { scope: "doc", styleRef: "punch-pop" }),
      op("SetRender", {}),
    ];
    expect(rebaseOps(incoming, [])).toEqual({ rebased: incoming, rejected: [] });
  });
});
