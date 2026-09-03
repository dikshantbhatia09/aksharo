import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type WordId } from "../ids.js";
import { type EdgOp } from "../schemas/ops.js";
import { type Pass } from "../schemas/pass.js";
import { type Word } from "../schemas/transcript.js";
import { charCount, limitsFor } from "../segmenter/script.js";
import {
  DEFAULT_SEGMENTER_PARAMS,
  segmentScript,
  segmentWords,
  wrapLines,
} from "../segmenter/segmenter.js";
import { buildFixture, idFactory } from "../testing.js";
import { validateProjection } from "../validate.js";
import { applyOps } from "./apply.js";
import { analyseOpsSince, rebaseOps } from "./rebase.js";
import { fromProjection, toProjection, type EdgState } from "./state.js";

/**
 * The properties the ops engine has to hold for **every** input, not just the
 * cases a table test happened to list (CONTRACTS §9: fast-check for EDG ops).
 */

const mint = idFactory(2_000_000);

function seededPass(passId: string, itemIds: readonly string[]): Pass {
  return {
    passId,
    type: "autocut",
    engine: "autocut@2",
    params: {},
    status: "ready",
    items: itemIds.map((itemId, index) => ({
      itemId,
      passId,
      kind: "cut" as const,
      startMs: index * 1000,
      endMs: index * 1000 + 400,
      payload: {},
      state: "proposed" as const,
    })),
  };
}

interface World {
  state: EdgState;
  segmentIds: string[];
  wordIds: WordId[];
  itemIds: string[];
}

/** A document with segments, a transcript and one pass to decide on. */
function world(): World {
  const fixture = buildFixture();
  const worldIds = idFactory(1_000_000);
  const passId = worldIds();
  const itemIds = [worldIds(), worldIds()];
  const projection = { ...fixture.projection, passes: [seededPass(passId, itemIds)] };
  return {
    state: fromProjection(projection, { chunks: fixture.chunks }),
    segmentIds: fixture.segmentIds,
    wordIds: fixture.wordIds,
    itemIds,
  };
}

const base = world();

/**
 * An op **without** its `opId` and without the ids it mints. An arbitrary has to
 * be pure — fast-check may read a generated value more than once — so the ids are
 * stamped on afterwards, by `materialise`, inside the property itself.
 */
type OpSpec = Record<string, unknown>;

let mintedWordSeq = 500;

/** Stamps an `opId`, and the ids a creating op needs, onto generated specs. */
function materialise(specs: readonly OpSpec[]): EdgOp[] {
  return specs.map((spec) => {
    const op: Record<string, unknown> = { opId: mint(), ...spec };
    // Ops that create something need an id the document has never seen.
    if (op["type"] === "SplitSegment" || op["type"] === "MergeSegments") {
      op["newSegmentId"] = mint();
    }
    if (op["type"] === "InsertWordAfter") {
      mintedWordSeq += 1;
      op["newWordId"] = `0:${String(mintedWordSeq)}`;
    }
    if (op["type"] === "SetProtectedRanges") {
      const ranges = op["ranges"] as { s: number; e: number }[];
      op["ranges"] = ranges.map((range) => ({ id: mint(), ...range }));
    }
    return op as unknown as EdgOp;
  });
}

/** Any op a client could plausibly send at this document, valid or not. */
function anyOp({ segmentIds, wordIds, itemIds }: World): fc.Arbitrary<OpSpec> {
  const segmentId = fc.constantFrom(...segmentIds);
  const wordId = fc.constantFrom(...wordIds);
  const script = fc.constantFrom("roman" as const, "native" as const, "en" as const);
  const ms = fc.nat({ max: 6000 });
  return fc
    .oneof(
      fc.record({
        type: fc.constant("SetSegmentText" as const),
        segmentId,
        script,
        text: fc.string({ maxLength: 24 }),
      }),
      fc.record({
        type: fc.constant("SetSegmentBounds" as const),
        segmentId,
        startMs: ms,
        endMs: ms,
        startWordId: wordId,
        endWordId: wordId,
      }),
      fc.record({ type: fc.constant("SplitSegment" as const), segmentId, atWordId: wordId }),
      fc.record({
        type: fc.constant("MergeSegments" as const),
        segmentIds: fc.uniqueArray(segmentId, { minLength: 2, maxLength: 3 }),
      }),
      fc.record({
        type: fc.constant("SetEmphasis" as const),
        segmentId,
        wordId,
        presetId: fc.constantFrom("pop", "shake", null),
      }),
      fc.record({
        type: fc.constant("SetSegmentPosition" as const),
        segmentId,
        position: fc.constantFrom(null, { x: 0.5, y: 0.8, anchor: "bottom-center" }),
      }),
      fc.record({ type: fc.constant("HideSegment" as const), segmentId, hidden: fc.boolean() }),
      fc.record({
        type: fc.constant("SetStyle" as const),
        scope: fc.constant("segment" as const),
        segmentId,
        styleRef: fc.constantFrom("punch-pop", "clean-caption"),
      }),
      fc.record({
        type: fc.constant("SetStyle" as const),
        scope: fc.constant("doc" as const),
        styleRef: fc.constantFrom("punch-pop", "clean-caption"),
      }),
      fc.record({
        type: fc.constant("EditWord" as const),
        wordId,
        text: fc.string({ minLength: 1, maxLength: 12 }),
      }),
      fc.record({ type: fc.constant("DeleteWord" as const), wordId }),
      fc.record({
        type: fc.constant("InsertWordAfter" as const),
        wordId,
        text: fc.string({ minLength: 1, maxLength: 12 }),
        s: ms,
        e: ms,
      }),
      fc.record({
        type: fc.constant("SetWordTiming" as const),
        wordId,
        s: ms,
        e: ms,
      }),
      fc.record({
        type: fc.constant("Resegment" as const),
        maxChars: fc.integer({ min: 8, max: 48 }),
        maxLines: fc.integer({ min: 1, max: 3 }),
        minMs: fc.constant(700),
        maxMs: fc.constant(6000),
      }),
      fc.record({
        type: fc.constant("DecideItems" as const),
        itemIds: fc.uniqueArray(fc.constantFrom(...itemIds), { minLength: 1 }),
        state: fc.constantFrom("accepted" as const, "rejected" as const),
      }),
      fc.record({
        type: fc.constant("SetAudio" as const),
        clean: fc.option(fc.record({ enabled: fc.boolean() }), { nil: undefined }),
        ducking: fc.option(fc.record({ enabled: fc.boolean() }), { nil: undefined }),
      }),
      fc.record({
        type: fc.constant("SetRender" as const),
        presets: fc.array(fc.constantFrom("social", "broadcast"), { maxLength: 2 }),
      }),
      fc.record({
        type: fc.constant("SetProtectedRanges" as const),
        ranges: fc.array(fc.record({ s: ms, e: ms }), { maxLength: 4 }),
      }),
    )
    .map((generated) => generated as OpSpec);
}

const anyBatch = fc.array(anyOp(base), { minLength: 1, maxLength: 8 });

/**
 * Ops that are always applicable to the fixture: they address ids that exist,
 * stay inside their segment, and cannot invalidate one another. Anything that
 * tombstones an id is deliberately absent, so a batch of these must apply whole.
 */
function validOp({ segmentIds, wordIds, itemIds }: World): fc.Arbitrary<OpSpec> {
  const WORDS_PER_SEGMENT = 4;
  const segmentIndex = fc.integer({ min: 0, max: segmentIds.length - 1 });
  const inSegment = segmentIndex.chain((index) =>
    fc.record({
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      segmentId: fc.constant(segmentIds[index] ?? ""),
      wordId: fc.constantFrom(
        ...wordIds.slice(index * WORDS_PER_SEGMENT, (index + 1) * WORDS_PER_SEGMENT),
      ),
    }),
  );
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const segmentId = segmentIndex.map((index) => segmentIds[index] ?? "");
  return fc
    .oneof(
      fc.record({
        type: fc.constant("SetSegmentText" as const),
        segmentId,
        script: fc.constantFrom("roman" as const, "native" as const, "en" as const),
        text: fc.string({ maxLength: 24 }),
      }),
      fc.record({ type: fc.constant("HideSegment" as const), segmentId, hidden: fc.boolean() }),
      fc.record({
        type: fc.constant("SetSegmentPosition" as const),
        segmentId,
        position: fc.constantFrom(null, { x: 0.5, y: 0.8, anchor: "bottom-center" }),
      }),
      fc.record({
        type: fc.constant("SetStyle" as const),
        scope: fc.constant("segment" as const),
        segmentId,
        styleRef: fc.constantFrom("punch-pop", "clean-caption"),
      }),
      fc.record({
        type: fc.constant("SetStyle" as const),
        scope: fc.constant("doc" as const),
        styleRef: fc.constantFrom("punch-pop", "clean-caption"),
      }),
      inSegment.map((pair) => ({
        type: "SetEmphasis" as const,
        segmentId: pair.segmentId,
        wordId: pair.wordId,
        presetId: "pop",
      })),
      fc.record({
        type: fc.constant("EditWord" as const),
        wordId: fc.constantFrom(...wordIds),
        text: fc.string({ minLength: 1, maxLength: 12 }),
      }),
      fc.record({
        type: fc.constant("DecideItems" as const),
        itemIds: fc.uniqueArray(fc.constantFrom(...itemIds), { minLength: 1 }),
        state: fc.constantFrom("accepted" as const, "rejected" as const),
      }),
      fc.record({
        type: fc.constant("SetAudio" as const),
        clean: fc.record({ enabled: fc.boolean() }),
      }),
      fc.record({
        type: fc.constant("SetRender" as const),
        presets: fc.array(fc.constantFrom("social", "broadcast"), { maxLength: 2 }),
      }),
    )
    .map((generated) => generated as OpSpec);
}

const validBatch = fc.array(validOp(base), { minLength: 1, maxLength: 8 });

describe("applyOps is idempotent", () => {
  it("never applies an op that already landed, however the batch is replayed", () => {
    fc.assert(
      fc.property(anyBatch, (specs) => {
        const ops = materialise(specs);
        const once = applyOps(world().state, ops, { source: "worker" });
        const twice = applyOps(once.state, ops, { source: "worker" });
        // Everything that landed comes back as a retry, in the same order, and
        // edits nothing. An op the first pass *rejected* is judged again against
        // the document it now faces, which is the point of a per-op verdict.
        expect(twice.skipped).toEqual(once.applied);
        // A replay never loses an op that landed, and the only ops it can add
        // are ones the first pass rejected against a document that has since
        // moved on — never a second application of something already in.
        const landed = new Set(once.applied);
        const refused = new Set(once.rejected.map((rejection) => rejection.opId));
        for (const opId of once.applied) expect(twice.applied).toContain(opId);
        for (const opId of twice.applied) {
          if (!landed.has(opId)) expect(refused.has(opId)).toBe(true);
        }
        if (once.rejected.length === 0) {
          expect(twice.applied).toEqual(once.applied);
          expect(toProjection(twice.state)).toEqual(toProjection(once.state));
          expect([...twice.state.words.entries()]).toEqual([...once.state.words.entries()]);
        }
      }),
    );
  });

  it("leaves the document untouched when a batch that fully applied arrives twice", () => {
    fc.assert(
      fc.property(validBatch, (specs) => {
        const ops = materialise(specs);
        const once = applyOps(world().state, ops, { source: "worker" });
        expect(once.rejected).toEqual([]);
        const twice = applyOps(once.state, ops, { source: "worker" });
        expect(twice.applied).toEqual(once.applied);
        expect(twice.skipped).toEqual(once.applied);
        expect(twice.rejected).toEqual([]);
        expect(toProjection(twice.state)).toEqual(toProjection(once.state));
        expect([...twice.state.words.entries()]).toEqual([...once.state.words.entries()]);
      }),
    );
  });
});

describe("commuting ops converge", () => {
  it("reaches the same document however the batch is ordered", () => {
    const { state, segmentIds, wordIds, itemIds } = world();
    // One op per (target, field): nothing here can see anything else's write.
    const independent: EdgOp[] = [
      { opId: mint(), type: "HideSegment", segmentId: segmentIds[0] ?? "", hidden: true },
      {
        opId: mint(),
        type: "SetSegmentText",
        segmentId: segmentIds[1] ?? "",
        script: "en",
        text: "second",
      },
      {
        opId: mint(),
        type: "SetSegmentPosition",
        segmentId: segmentIds[2] ?? "",
        position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
      },
      {
        opId: mint(),
        type: "SetEmphasis",
        segmentId: segmentIds[0] ?? "",
        wordId: wordIds[1] ?? "0:1",
        presetId: "pop",
      },
      { opId: mint(), type: "EditWord", wordId: wordIds[5] ?? "0:5", text: "corrected" },
      { opId: mint(), type: "DecideItems", itemIds: [itemIds[0] ?? ""], state: "accepted" },
      { opId: mint(), type: "SetAudio", clean: { enabled: true } },
      { opId: mint(), type: "SetRender", presets: ["social"] },
      { opId: mint(), type: "SetStyle", scope: "doc", styleRef: "clean-caption" },
    ];
    const expected = toProjection(applyOps(state, independent).state);

    fc.assert(
      fc.property(
        fc.shuffledSubarray(independent, {
          minLength: independent.length,
          maxLength: independent.length,
        }),
        (ordered) => {
          const result = applyOps(state, ordered);
          expect(result.rejected).toEqual([]);
          expect(toProjection(result.state)).toEqual(expected);
        },
      ),
    );
  });

  it("reaches the same document when splits of distant segments are interleaved", () => {
    const { state, segmentIds, wordIds } = world();
    const splits: EdgOp[] = [
      {
        opId: mint(),
        type: "SplitSegment",
        segmentId: segmentIds[0] ?? "",
        atWordId: wordIds[2] ?? "0:2",
        newSegmentId: mint(),
      },
      {
        opId: mint(),
        type: "SplitSegment",
        segmentId: segmentIds[2] ?? "",
        atWordId: wordIds[10] ?? "0:10",
        newSegmentId: mint(),
      },
    ];
    const expected = toProjection(applyOps(state, splits).state);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(splits, { minLength: splits.length, maxLength: splits.length }),
        (ordered) => {
          expect(toProjection(applyOps(state, ordered).state)).toEqual(expected);
        },
      ),
    );
  });
});

describe("the document stays valid", () => {
  it("holds every projection invariant after any sequence of ops", () => {
    fc.assert(
      fc.property(anyBatch, anyBatch, (firstSpecs, secondSpecs) => {
        const first = materialise(firstSpecs);
        const second = materialise(secondSpecs);
        const start = world().state;
        const once = applyOps(start, first, { source: "worker" });
        const twice = applyOps(once.state, second, { source: "worker" });
        expect(once.applied.length + once.rejected.length).toBe(first.length);
        expect(twice.applied.length + twice.rejected.length).toBe(second.length);
        for (const state of [once.state, twice.state]) {
          expect(validateProjection(toProjection(state), { wordIndex: state.words })).toEqual([]);
          // Segment order and the segment map never disagree.
          expect([...state.segmentOrder].sort()).toEqual([...state.segments.keys()].sort());
          // A tombstoned segment is never live again.
          for (const id of state.tombstones) expect(state.segments.has(id)).toBe(false);
          // The protected set is always sorted and non-overlapping, every row
          // is a user range, and every range is non-empty.
          const protectedRanges = state.hot.protected ?? [];
          for (const range of protectedRanges) {
            expect(range.s).toBeLessThan(range.e);
            expect(range.reason).toBe("user");
          }
          for (let i = 1; i < protectedRanges.length; i += 1) {
            const previous = protectedRanges[i - 1];
            // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
            const current = protectedRanges[i];
            if (previous === undefined || current === undefined) continue;
            expect(previous.s).toBeLessThanOrEqual(current.s);
            expect(previous.e).toBeLessThan(current.s);
          }
        }
      }),
    );
  });
});

describe("rebaseOps never resurrects a dead id", () => {
  it("produces no op naming a segment merged away or a word deleted since the base", () => {
    fc.assert(
      fc.property(anyBatch, anyBatch, (incomingSpecs, sinceSpecs) => {
        const incoming = materialise(incomingSpecs);
        const opsSince = materialise(sinceSpecs);
        const { rebased, rejected } = rebaseOps(incoming, opsSince);
        const since = analyseOpsSince(opsSince);
        expect(rebased.length + rejected.length).toBe(incoming.length);
        for (const op of rebased) {
          for (const id of referenced(op)) {
            expect(since.deadSegments.has(id), `${op.type} names dead segment ${id}`).toBe(false);
            expect(since.deletedWords.has(id), `${op.type} names deleted word ${id}`).toBe(false);
          }
          if (since.resegmented) {
            expect(referencedSegmentIds(op)).toEqual([]);
          }
        }
      }),
    );
  });

  it("never drops a caption-text edit silently", () => {
    fc.assert(
      fc.property(anyBatch, anyBatch, (incomingSpecs, sinceSpecs) => {
        const incoming = materialise(incomingSpecs);
        const opsSince = materialise(sinceSpecs);
        const { rejected } = rebaseOps(incoming, opsSince);
        const byOpId = new Map(incoming.map((op) => [op.opId, op]));
        for (const rejection of rejected) {
          if (byOpId.get(rejection.opId)?.type !== "SetSegmentText") continue;
          // Losing the field is a conflict for the client to resolve; the other
          // reasons mean the segment itself is gone, which the client can see.
          expect(["conflict", "stale", "stale-after-resegment"]).toContain(rejection.reason);
        }
      }),
    );
  });

  it("keeps every rebased op applicable, or rejects it with a reason", () => {
    fc.assert(
      fc.property(anyBatch, anyBatch, (incomingSpecs, sinceSpecs) => {
        const incoming = materialise(incomingSpecs);
        const opsSince = materialise(sinceSpecs);
        const start = world().state;
        const applied = applyOps(start, opsSince, { source: "worker" });
        const { rebased } = rebaseOps(incoming, opsSince);
        const result = applyOps(applied.state, rebased, { source: "worker" });
        // Whatever the verdict, the document is still well formed.
        expect(
          validateProjection(toProjection(result.state), { wordIndex: result.state.words }),
        ).toEqual([]);
      }),
    );
  });
});

function referencedSegmentIds(op: EdgOp): string[] {
  if (op.type === "MergeSegments") return [...op.segmentIds];
  if (op.type === "SetStyle")
    return op.scope === "segment" && op.segmentId !== undefined ? [op.segmentId] : [];
  return "segmentId" in op && typeof op.segmentId === "string" ? [op.segmentId] : [];
}

function referenced(op: EdgOp): string[] {
  const ids = referencedSegmentIds(op);
  if ("wordId" in op && typeof op.wordId === "string") ids.push(op.wordId);
  if ("atWordId" in op && typeof op.atWordId === "string") ids.push(op.atWordId);
  if ("startWordId" in op && typeof op.startWordId === "string") ids.push(op.startWordId);
  if ("endWordId" in op && typeof op.endWordId === "string") ids.push(op.endWordId);
  return ids;
}

describe("the segmenter", () => {
  const wordStream = fc.array(
    fc.record({
      t: fc.stringMatching(/^[a-z]{1,10}$/u),
      durationMs: fc.integer({ min: 80, max: 2500 }),
      gapMs: fc.integer({ min: 0, max: 900 }),
      sp: fc.constantFrom("sp1", "sp2"),
      filler: fc.boolean(),
      deleted: fc.boolean(),
    }),
    { minLength: 1, maxLength: 80 },
  );

  function toWords(
    specs: readonly {
      t: string;
      durationMs: number;
      gapMs: number;
      sp: string;
      filler: boolean;
      deleted: boolean;
    }[],
  ): Word[] {
    let cursor = 0;
    return specs.map((spec, index) => {
      const s = cursor;
      cursor = s + spec.durationMs + spec.gapMs;
      return {
        wid: `0:${index}` as WordId,
        s,
        e: s + spec.durationMs,
        t: spec.t,
        sp: spec.sp,
        filler: spec.filler,
        deleted: spec.deleted,
      };
    });
  }

  function ids(): () => string {
    let counter = 0;
    return () => {
      counter += 1;
      return `SEG${String(counter).padStart(3, "0")}`;
    };
  }

  it("covers every live word exactly once, in order", () => {
    fc.assert(
      fc.property(wordStream, fc.boolean(), (specs, dropFillers) => {
        const words = toWords(specs);
        const segments = segmentWords(words, {}, { newId: ids(), dropFillers });
        const positions = new Map(words.map((word, index) => [word.wid, index]));
        const covered: string[] = [];
        for (const segment of segments) {
          const from = positions.get(segment.startWordId);
          const to = positions.get(segment.endWordId);
          expect(from).toBeDefined();
          expect(to).toBeDefined();
          if (from === undefined || to === undefined) return;
          expect(to).toBeGreaterThanOrEqual(from);
          for (const word of words.slice(from, to + 1)) {
            if (word.deleted === true) continue;
            if (dropFillers && word.filler === true) continue;
            covered.push(word.wid);
          }
        }
        const live = words
          .filter((word) => word.deleted !== true && !(dropFillers && word.filler === true))
          .map((word) => word.wid);
        expect(covered).toEqual(live);
      }),
    );
  });

  it("respects the line budget, the maximum duration and one speaker per caption", () => {
    fc.assert(
      fc.property(wordStream, (specs) => {
        const words = toWords(specs);
        const segments = segmentWords(words, {}, { newId: ids() });
        const limits = limitsFor(segmentScript(words));
        const positions = new Map(words.map((word, index) => [word.wid, index]));
        for (const segment of segments) {
          const from = positions.get(segment.startWordId) ?? 0;
          const to = positions.get(segment.endWordId) ?? 0;
          const live = words.slice(from, to + 1).filter((word) => word.deleted !== true);
          const lines = wrapLines(
            live.map((word) => word.t),
            limits.maxCharsPerLine,
          );
          expect(lines.length).toBeLessThanOrEqual(DEFAULT_SEGMENTER_PARAMS.maxLines);
          for (const line of lines) {
            expect(charCount(line)).toBeLessThanOrEqual(limits.maxCharsPerLine);
          }
          expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(
            DEFAULT_SEGMENTER_PARAMS.maxMs,
          );
          expect(new Set(live.map((word) => word.sp)).size).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("is a pure function of its words and parameters", () => {
    fc.assert(
      fc.property(wordStream, (specs) => {
        const words = toWords(specs);
        expect(segmentWords(words, {}, { newId: ids() })).toEqual(
          segmentWords([...words], {}, { newId: ids() }),
        );
      }),
    );
  });
});
