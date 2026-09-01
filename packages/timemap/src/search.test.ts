import { describe, expect, it } from "vitest";

import { lowerBound, upperBound } from "./search.js";

/** Counts index reads so a probe budget can be asserted rather than timed. */
function counting(keys: readonly number[]): { keys: readonly number[]; probes: () => number } {
  let probes = 0;
  const proxy = new Proxy(keys as number[], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) probes += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { keys: proxy, probes: () => probes };
}

const naiveLower = (keys: readonly number[], value: number): number => {
  const index = keys.findIndex((key) => key >= value);
  return index === -1 ? keys.length : index;
};

const naiveUpper = (keys: readonly number[], value: number): number => {
  for (let i = keys.length - 1; i >= 0; i -= 1) if ((keys[i] as number) <= value) return i;
  return -1;
};

describe("lowerBound", () => {
  it("finds the first key at or above the value", () => {
    const keys = [0, 10, 10, 20, 30];
    expect(lowerBound(keys, -1)).toBe(0);
    expect(lowerBound(keys, 0)).toBe(0);
    expect(lowerBound(keys, 5)).toBe(1);
    expect(lowerBound(keys, 10)).toBe(1);
    expect(lowerBound(keys, 30)).toBe(4);
    expect(lowerBound(keys, 31)).toBe(5);
    expect(lowerBound([], 0)).toBe(0);
  });
});

describe("upperBound", () => {
  it("finds the last key at or below the value", () => {
    const keys = [0, 10, 10, 20, 30];
    expect(upperBound(keys, -1)).toBe(-1);
    expect(upperBound(keys, 0)).toBe(0);
    expect(upperBound(keys, 10)).toBe(2);
    expect(upperBound(keys, 19)).toBe(2);
    expect(upperBound(keys, 30)).toBe(4);
    expect(upperBound(keys, 99)).toBe(4);
    expect(upperBound([], 0)).toBe(-1);
  });
});

describe("both agree with a linear scan", () => {
  it("over a sorted array with duplicates", () => {
    const keys = Array.from({ length: 200 }, (_unused, index) => Math.floor(index / 2) * 3);
    for (let value = -2; value <= 302; value += 1) {
      expect(lowerBound(keys, value), `lowerBound(${value})`).toBe(naiveLower(keys, value));
      expect(upperBound(keys, value), `upperBound(${value})`).toBe(naiveUpper(keys, value));
    }
  });
});

describe("probe budget", () => {
  it.each([16, 1024, 65_536])("stays inside ceil(log2(n)) + 1 probes at n = %i", (size) => {
    const keys = Array.from({ length: size }, (_unused, index) => index * 2);
    const budget = Math.ceil(Math.log2(size)) + 1;
    for (const value of [0, 1, size, size * 2 - 1, size * 4]) {
      const low = counting(keys);
      lowerBound(low.keys, value);
      expect(low.probes(), `lowerBound(${value}) at n=${size}`).toBeLessThanOrEqual(budget);

      const high = counting(keys);
      upperBound(high.keys, value);
      expect(high.probes(), `upperBound(${value}) at n=${size}`).toBeLessThanOrEqual(budget);
    }
  });
});
