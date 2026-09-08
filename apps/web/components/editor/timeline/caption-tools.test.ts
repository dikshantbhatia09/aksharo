import { describe, expect, it } from "vitest";

import { applyOps, fromProjection, toProjection } from "@montaj/edg";
import type { EdgHot, Segment, TranscriptChunk, Word } from "@montaj/edg";

import {
  buildCaptionDelayOps,
  buildRemoveEmojiOps,
  buildRemoveEmphasisOps,
  buildRemoveGapsOps,
  buildRemovePunctuationOps,
  clampCaptionDelayMs,
  stripEmojis,
  stripPunctuation,
} from "./caption-tools";

/**
 * K06's Actions/Timing batch-op builders, verified two ways per acceptance
 * criterion 2 ("not a no-op UI element"): the pure string/clamp maths on
 * their own, and — for every builder that emits `EdgOp`s — by actually
 * running the batch through `@montaj/edg`'s own `applyOps` (the same engine
 * the API and the browser store both call) and asserting the *document*
 * changed, not just that some object got pushed into an array.
 */

let opCounter = 0;
function newId(): string {
  opCounter += 1;
  return `01OP${String(opCounter).padStart(22, "0")}`;
}

/**
 * A small fixture mirroring `apps/web/lib/edg/store.test.ts`'s own
 * `fixtureInit`: one chunk, a handful of words with punctuation/emoji/
 * emphasis already on them, and three segments — two touching with a gap
 * between them, a third far away — enough surface for every builder in
 * `caption-tools.ts` without a real transcript.
 */
function fixtureWords(): Word[] {
  return [
    { wid: "0:0", s: 0, e: 500, t: "Hello!!!" },
    { wid: "0:1", s: 600, e: 1_200, t: "world", scripts: { roman: "\u{1F525}world\u{1F525}" } },
    { wid: "0:2", s: 1_300, e: 1_800, t: "there" },
    { wid: "0:3", s: 5_000, e: 5_500, t: "clean" },
  ];
}

function fixtureChunks(): TranscriptChunk[] {
  return [{ chunkIdx: 0, startMs: 0, endMs: 6_000, words: fixtureWords() }];
}

function fixtureHot(): EdgHot {
  return {
    meta: { edgId: "e1", projectId: "p1", revision: 1, schemaVersion: 2 },
    media: [{ mediaId: "m1", role: "primary", durationMs: 10_000 }],
    transcript: { transcriptId: "t1", revision: 1, language: "en", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
  };
}

function fixtureSegments(): Segment[] {
  return [
    {
      id: "seg-a",
      seq: "V",
      startWordId: "0:0" as never,
      endWordId: "0:1" as never,
      startMs: 0,
      endMs: 1_200,
      emphasis: [{ wordId: "0:1" as never, presetId: "glow" }],
    },
    {
      // 100ms gap between seg-a.endMs (1200) and seg-b.startMs (1300).
      id: "seg-b",
      seq: "W",
      startWordId: "0:2" as never,
      endWordId: "0:2" as never,
      startMs: 1_300,
      endMs: 1_800,
    },
    {
      // A large gap after seg-b, and no emphasis at all.
      id: "seg-c",
      seq: "X",
      startWordId: "0:3" as never,
      endWordId: "0:3" as never,
      startMs: 5_000,
      endMs: 5_500,
    },
  ];
}

function fixtureState() {
  return fromProjection(
    { ...fixtureHot(), segments: fixtureSegments(), passes: [] },
    { chunks: fixtureChunks() },
  );
}

describe("stripPunctuation", () => {
  it("removes every punctuation mark and collapses the whitespace left behind", () => {
    expect(stripPunctuation("Hello!!!")).toBe("Hello");
    expect(stripPunctuation("don't")).toBe("dont");
    expect(stripPunctuation("co-founder")).toBe("cofounder");
    expect(stripPunctuation("(word)")).toBe("word");
    expect(stripPunctuation("U.S.A.")).toBe("USA");
  });

  it("leaves currency and math symbols alone — those are Symbol, not Punctuation", () => {
    expect(stripPunctuation("$5")).toBe("$5");
  });

  it("leaves already-clean text untouched", () => {
    expect(stripPunctuation("word")).toBe("word");
  });

  it("can strip a punctuation-only token down to empty", () => {
    expect(stripPunctuation("---")).toBe("");
  });
});

describe("stripEmojis", () => {
  it("removes a standalone emoji", () => {
    expect(stripEmojis("\u{1F600}")).toBe("");
  });

  it("removes emoji surrounding real text and collapses the gap", () => {
    expect(stripEmojis("\u{1F525}Fire\u{1F525}")).toBe("Fire");
  });

  it("removes a multi-codepoint ZWJ sequence (family emoji) without leaving an orphaned joiner", () => {
    expect(stripEmojis("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}family")).toBe("family");
  });

  it("removes a flag (regional indicator pair)", () => {
    expect(stripEmojis("\u{1F1EE}\u{1F1F3}India")).toBe("India");
  });

  it("leaves plain text untouched", () => {
    expect(stripEmojis("word")).toBe("word");
  });
});

describe("buildRemovePunctuationOps", () => {
  it("emits EditWord only for words whose punctuation-stripped text actually differs", () => {
    const words = fixtureWords();
    const ops = buildRemovePunctuationOps(words, "roman", newId);
    // "Hello!!!" (word.t, no roman override) changes; "there"/"clean" don't.
    // "world" has a roman override with emoji, not punctuation, so it's untouched here too.
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: "EditWord",
      wordId: "0:0",
      text: "Hello",
      script: "roman",
    });
  });

  it("skips a word that would clean to nothing rather than emitting an empty-text edit", () => {
    const words: Word[] = [{ wid: "0:0", s: 0, e: 500, t: "---" }];
    expect(buildRemovePunctuationOps(words, "roman", newId)).toHaveLength(0);
  });

  it("skips deleted (tombstoned) words", () => {
    const words: Word[] = [{ wid: "0:0", s: 0, e: 500, t: "Hi!", deleted: true }];
    expect(buildRemovePunctuationOps(words, "roman", newId)).toHaveLength(0);
  });

  it("really changes the document: applying the batch strips punctuation from the live word", () => {
    const state = fixtureState();
    const words = [...state.words.values()];
    const ops = buildRemovePunctuationOps(words, "roman", newId);
    const result = applyOps(state, ops);
    expect(result.rejected).toHaveLength(0);
    const edited = result.state.words.get("0:0" as never);
    expect(edited?.scripts?.roman).toBe("Hello");
    // The base transcript text is untouched — only the displayed script's slot changed,
    // exactly like the transcript column's own `onEditWord` (`editor-client.tsx`).
    expect(edited?.t).toBe("Hello!!!");
  });
});

describe("buildRemoveEmojiOps", () => {
  it("emits EditWord only for the word carrying an emoji in the current script", () => {
    const words = fixtureWords();
    const ops = buildRemoveEmojiOps(words, "roman", newId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: "EditWord",
      wordId: "0:1",
      text: "world",
      script: "roman",
    });
  });

  it("really changes the document: applying the batch strips the emoji from the live word", () => {
    const state = fixtureState();
    const words = [...state.words.values()];
    const ops = buildRemoveEmojiOps(words, "roman", newId);
    const result = applyOps(state, ops);
    expect(result.rejected).toHaveLength(0);
    const edited = result.state.words.get("0:1" as never);
    expect(edited?.scripts?.roman).toBe("world");
  });
});

describe("buildRemoveEmphasisOps", () => {
  it("emits one SetEmphasis(null) per emphasis entry, and none for a segment with no emphasis", () => {
    const segments = fixtureSegments();
    const ops = buildRemoveEmphasisOps(segments, newId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: "SetEmphasis",
      segmentId: "seg-a",
      wordId: "0:1",
      presetId: null,
    });
  });

  it("really changes the document: applying the batch clears the segment's emphasis array", () => {
    const state = fixtureState();
    const segments = [...state.segments.values()];
    const ops = buildRemoveEmphasisOps(segments, newId);
    const result = applyOps(state, ops);
    expect(result.rejected).toHaveLength(0);
    const projection = toProjection(result.state);
    const segA = projection.segments.find((s) => s.id === "seg-a");
    expect(segA?.emphasis ?? []).toHaveLength(0);
  });
});

describe("buildRemoveGapsOps", () => {
  it("closes a gap between two consecutive, non-hidden segments by extending the earlier one", () => {
    const segments = fixtureSegments();
    const ops = buildRemoveGapsOps(segments, newId);
    // seg-a -> seg-b has a 100ms gap (1200 -> 1300); seg-b -> seg-c has a big one (1800 -> 5000).
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      type: "SetSegmentBounds",
      segmentId: "seg-a",
      startMs: 0,
      endMs: 1_300,
    });
    expect(ops[1]).toMatchObject({
      type: "SetSegmentBounds",
      segmentId: "seg-b",
      startMs: 1_300,
      endMs: 5_000,
    });
  });

  it("emits nothing for segments that already touch (no gap)", () => {
    const segments: Segment[] = [
      {
        id: "a",
        seq: "A",
        startWordId: "0:0" as never,
        endWordId: "0:0" as never,
        startMs: 0,
        endMs: 500,
      },
      {
        id: "b",
        seq: "B",
        startWordId: "0:1" as never,
        endWordId: "0:1" as never,
        startMs: 500,
        endMs: 1_000,
      },
    ];
    expect(buildRemoveGapsOps(segments, newId)).toHaveLength(0);
  });

  it("ignores hidden segments and is order-independent (sorts by seq internally)", () => {
    const segments: Segment[] = [
      {
        id: "b",
        seq: "W",
        startWordId: "0:2" as never,
        endWordId: "0:2" as never,
        startMs: 1_300,
        endMs: 1_800,
      },
      {
        id: "a",
        seq: "V",
        startWordId: "0:0" as never,
        endWordId: "0:1" as never,
        startMs: 0,
        endMs: 1_200,
      },
      {
        id: "hidden",
        seq: "U",
        startWordId: "0:0" as never,
        endWordId: "0:0" as never,
        startMs: 1_200,
        endMs: 1_250,
        hidden: true,
      },
    ];
    const ops = buildRemoveGapsOps(segments, newId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ segmentId: "a", startMs: 0, endMs: 1_300 });
  });

  it("really changes the document: applying the batch removes the dead air between captions", () => {
    const state = fixtureState();
    const segments = [...state.segments.values()];
    const ops = buildRemoveGapsOps(segments, newId);
    const result = applyOps(state, ops);
    expect(result.rejected).toHaveLength(0);
    const projection = toProjection(result.state);
    const segA = projection.segments.find((s) => s.id === "seg-a");
    const segB = projection.segments.find((s) => s.id === "seg-b");
    expect(segA?.endMs).toBe(1_300);
    expect(segB?.startMs).toBe(1_300);
    expect(segB?.endMs).toBe(5_000);
    // Word timings are untouched by this action — only the caption envelope moved.
    expect(result.state.words.get("0:1" as never)?.e).toBe(1_200);
  });
});

describe("clampCaptionDelayMs", () => {
  const segments = fixtureSegments(); // spans [0, 5_500]

  it("passes a requested offset through when it fits within the media duration", () => {
    expect(clampCaptionDelayMs(segments, 1_000, 10_000)).toBe(1_000);
  });

  it("clamps a positive offset so the last segment never runs past the duration", () => {
    // maxEnd = 5_500, durationMs = 10_000 -> upperBound = 4_500.
    expect(clampCaptionDelayMs(segments, 6_000, 10_000)).toBe(4_500);
  });

  it("clamps a negative offset so the first segment never goes below zero", () => {
    // minStart = 0 -> lowerBound = 0, so any negative request clamps to 0.
    expect(clampCaptionDelayMs(segments, -1_000, 10_000)).toBe(0);
  });

  it("clamps a negative offset to the room actually available when segments start later", () => {
    const shifted: Segment[] = segments.map((s) => ({
      ...s,
      startMs: s.startMs + 1_000,
      endMs: s.endMs + 1_000,
    }));
    // minStart = 1_000 -> lowerBound = -1_000.
    expect(clampCaptionDelayMs(shifted, -5_000, 11_000)).toBe(-1_000);
  });

  it("returns 0 when there is no room to shift in either direction", () => {
    const full: Segment[] = [
      {
        id: "a",
        seq: "A",
        startWordId: "0:0" as never,
        endWordId: "0:0" as never,
        startMs: 0,
        endMs: 10_000,
      },
    ];
    expect(clampCaptionDelayMs(full, 500, 10_000)).toBe(0);
  });

  it("returns 0 for an empty document", () => {
    expect(clampCaptionDelayMs([], 500, 10_000)).toBe(0);
  });
});

describe("buildCaptionDelayOps", () => {
  it("emits nothing for a zero offset", () => {
    expect(buildCaptionDelayOps(fixtureSegments(), 0, newId)).toHaveLength(0);
  });

  it("emits one SetSegmentBounds per segment, shifted by the offset", () => {
    const ops = buildCaptionDelayOps(fixtureSegments(), 250, newId);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({
      type: "SetSegmentBounds",
      segmentId: "seg-a",
      startMs: 250,
      endMs: 1_450,
    });
    expect(ops[1]).toMatchObject({ segmentId: "seg-b", startMs: 1_550, endMs: 2_050 });
    expect(ops[2]).toMatchObject({ segmentId: "seg-c", startMs: 5_250, endMs: 5_750 });
  });

  it("really changes the document: applying the clamped batch shifts every caption's on-screen window, leaves words and validity untouched", () => {
    const state = fixtureState();
    const segments = [...state.segments.values()];
    const requested = 1_000;
    const clamped = clampCaptionDelayMs(segments, requested, 10_000);
    const ops = buildCaptionDelayOps(segments, clamped, newId);
    const result = applyOps(state, ops);
    expect(result.rejected).toHaveLength(0);

    const projection = toProjection(result.state);
    for (const before of segments) {
      const after = projection.segments.find((s) => s.id === before.id);
      expect(after?.startMs).toBe(before.startMs + clamped);
      expect(after?.endMs).toBe(before.endMs + clamped);
    }
    // Word timestamps are deliberately untouched by a delay shift (see the
    // builder's own doc comment) — only the segment envelope moves.
    expect(result.state.words.get("0:0" as never)?.s).toBe(0);
  });
});
