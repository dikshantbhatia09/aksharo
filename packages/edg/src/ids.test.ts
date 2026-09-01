import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createUlidFactory,
  IdError,
  isUlid,
  isWordId,
  makeWordId,
  newId,
  parseWordId,
  ULID_ALPHABET,
  ulidTime,
} from "./ids.js";

describe("ULIDs", () => {
  it("mints 26-character Crockford base-32 ids", () => {
    const id = newId();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect([...id].every((char) => ULID_ALPHABET.includes(char))).toBe(true);
  });

  it("encodes the mint time in the prefix", () => {
    const at = Date.UTC(2026, 0, 15, 9, 30, 0);
    const id = createUlidFactory({ now: () => at })();
    expect(ulidTime(id)).toBe(at);
  });

  it("stays monotonic inside one millisecond", () => {
    const ulid = createUlidFactory({
      now: () => 1_700_000_000_000,
      randomDigits: () => new Array(16).fill(0),
    });
    const ids = [ulid(), ulid(), ulid()];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it("stays monotonic when the clock steps backwards", () => {
    let time = 1_700_000_000_000;
    const ulid = createUlidFactory({ now: () => time, randomDigits: () => new Array(16).fill(5) });
    const first = ulid();
    time -= 5_000;
    const second = ulid();
    expect(second > first).toBe(true);
  });

  it("carries across digits when the random field rolls over", () => {
    const digits = [...new Array(15).fill(0), 31];
    const ulid = createUlidFactory({
      now: () => 1_700_000_000_000,
      randomDigits: () => [...digits],
    });
    const first = ulid();
    const second = ulid();
    expect(first.slice(-2)).toBe("0Z");
    expect(second.slice(-2)).toBe("10");
    expect(second > first).toBe(true);
  });

  it("refuses to mint when the randomness is exhausted", () => {
    const ulid = createUlidFactory({
      now: () => 1_700_000_000_000,
      randomDigits: () => new Array(16).fill(31),
    });
    ulid();
    expect(() => ulid()).toThrow(/randomness exhausted/);
  });

  it("rejects a random source of the wrong width", () => {
    const ulid = createUlidFactory({ now: () => 1, randomDigits: () => [1, 2, 3] });
    expect(() => ulid()).toThrow(IdError);
  });

  it("rejects out-of-range times and non-ULIDs", () => {
    expect(() => createUlidFactory({ now: () => -1 })()).toThrow(IdError);
    expect(() => createUlidFactory({ now: () => 2 ** 49 })()).toThrow(/ULID time/);
    expect(() => ulidTime("nope")).toThrow(IdError);
    expect(isUlid("0000000000000000000000000")).toBe(false); // 25 characters
    expect(isUlid("80000000000000000000000000")).toBe(false); // time overflow
    expect(isUlid("0000000000000000000000000I")).toBe(false); // I is not in the alphabet
    expect(isUlid(42)).toBe(false);
  });

  it("sorts by mint time", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 2, maxLength: 20 }),
        (gaps) => {
          let time = 1_700_000_000_000;
          const ulid = createUlidFactory({ now: () => time });
          const ids = gaps.map((gap) => {
            time += gap;
            return ulid();
          });
          expect([...ids].sort()).toEqual(ids);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("word ids", () => {
  it("builds and parses", () => {
    expect(makeWordId(3, 1274)).toBe("3:1274");
    expect(parseWordId("3:1274")).toEqual({ chunkIdx: 3, n: 1274 });
  });

  it("round-trips any pair of indices", () => {
    fc.assert(
      fc.property(fc.nat({ max: 5_000 }), fc.nat({ max: 500_000 }), (chunkIdx, n) => {
        const wid = makeWordId(chunkIdx, n);
        expect(isWordId(wid)).toBe(true);
        expect(parseWordId(wid)).toEqual({ chunkIdx, n });
      }),
      { numRuns: 200 },
    );
  });

  it("rejects malformed ids", () => {
    expect(() => makeWordId(-1, 0)).toThrow(/chunkIdx/);
    expect(() => makeWordId(0, 1.5)).toThrow(/n must be/);
    expect(() => parseWordId("3-1274")).toThrow(IdError);
    expect(isWordId("3:")).toBe(false);
    expect(isWordId(3)).toBe(false);
  });
});
