import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  compareSeqKeys,
  isSeqKey,
  SEQ_ALPHABET,
  SeqError,
  seqBetween,
  seqSequence,
} from "./seq.js";

describe("seqBetween", () => {
  it("seeds an empty list in the middle of the range", () => {
    expect(seqBetween()).toBe("V");
    expect(seqBetween(null, null)).toBe("V");
  });

  it("appends after a key and prepends before one", () => {
    expect(seqBetween("V")).toBe("l");
    expect(seqBetween(undefined, "V")).toBe("G");
    expect(seqBetween("V") > "V").toBe(true);
    expect(seqBetween(undefined, "V") < "V").toBe(true);
  });

  it("subdivides adjacent digits by growing the key", () => {
    expect(seqBetween("1", "2")).toBe("1V");
    expect(seqBetween("1", "10V")).toBe("10G");
    expect(seqBetween("zzz")).toBe("zzzV");
  });

  it("keeps the shared prefix", () => {
    expect(seqBetween("1A", "1C")).toBe("1B");
  });

  it("uses the first digit of a longer neighbour", () => {
    expect(seqBetween("1", "21")).toBe("2");
  });

  it("rejects an out-of-order pair", () => {
    expect(() => seqBetween("b", "a")).toThrow(SeqError);
    expect(() => seqBetween("a", "a")).toThrow(/strictly increasing/);
  });

  it("rejects non-canonical keys", () => {
    expect(() => seqBetween("V0")).toThrow(SeqError);
    expect(() => seqBetween("v!")).toThrow(/before must be/);
    expect(() => seqBetween(undefined, "-")).toThrow(/after must be/);
    // An empty string is the same "nothing before" sentinel as undefined, so a
    // null column read straight from the database behaves.
    expect(seqBetween("")).toBe("V");
  });

  it("orders the alphabet the same way ASCII does", () => {
    const sorted = [...SEQ_ALPHABET].sort();
    expect(sorted.join("")).toBe(SEQ_ALPHABET);
  });
});

describe("seqSequence", () => {
  it("returns ascending keys", () => {
    const keys = seqSequence(5);
    expect(keys).toHaveLength(5);
    expect([...keys].sort()).toEqual(keys);
  });

  it("returns nothing for zero and rejects a bad count", () => {
    expect(seqSequence(0)).toEqual([]);
    expect(() => seqSequence(-1)).toThrow(SeqError);
    expect(() => seqSequence(1.5)).toThrow(SeqError);
  });
});

describe("compareSeqKeys", () => {
  it("is a lexicographic comparator", () => {
    expect(compareSeqKeys("1", "2")).toBe(-1);
    expect(compareSeqKeys("2", "1")).toBe(1);
    expect(compareSeqKeys("1", "1")).toBe(0);
  });
});

describe("seqBetween properties", () => {
  /** Rebuilds a segment list by inserting at random positions, as the editor does. */
  const insertionPlan = fc.array(fc.nat({ max: 64 }), { minLength: 1, maxLength: 60 });

  it("keeps lexicographic order equal to insertion order", () => {
    fc.assert(
      fc.property(insertionPlan, (positions) => {
        const keys: string[] = [];
        for (const raw of positions) {
          const at = raw % (keys.length + 1);
          const key = seqBetween(keys[at - 1], keys[at]);
          keys.splice(at, 0, key);
        }
        expect(keys.every((key) => isSeqKey(key))).toBe(true);
        expect(new Set(keys).size).toBe(keys.length);
        // The list is in document order, so it must already be sorted.
        expect([...keys].sort()).toEqual(keys);
      }),
      { numRuns: 200 },
    );
  });

  it("always finds room between two neighbours, however often it is asked", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 120 }), (rounds) => {
        let low = seqBetween();
        let high = seqBetween(low);
        for (let i = 0; i < rounds; i += 1) {
          const middle = seqBetween(low, high);
          expect(middle > low).toBe(true);
          expect(middle < high).toBe(true);
          expect(isSeqKey(middle)).toBe(true);
          // Alternate which side collapses so both the "grow" and the "shared
          // prefix" branches are exercised.
          if (i % 2 === 0) low = middle;
          else high = middle;
        }
      }),
      { numRuns: 50 },
    );
  });

  it("appends and prepends without bound", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), (rounds) => {
        let last = seqBetween();
        let first = last;
        for (let i = 0; i < rounds; i += 1) {
          const next = seqBetween(last);
          const previous = seqBetween(undefined, first);
          expect(next > last).toBe(true);
          expect(previous < first).toBe(true);
          last = next;
          first = previous;
        }
      }),
      { numRuns: 30 },
    );
  });
});
