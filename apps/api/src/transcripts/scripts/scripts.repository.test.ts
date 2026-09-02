import { describe, expect, it } from "vitest";

import type { Word } from "@montaj/edg/schemas";

import { groupByChunk, mergeScripts } from "./scripts.repository.js";

import type { ScriptWordInput } from "./scripts.repository.js";

function word(wid: string, t: string, scripts?: Word["scripts"]): Word {
  return {
    wid: wid as Word["wid"],
    s: 0,
    e: 100,
    t,
    ...(scripts === undefined ? {} : { scripts }),
  };
}

describe("groupByChunk", () => {
  it("groups word patches by the chunk their wid names", () => {
    const inputs: ScriptWordInput[] = [
      { wid: "0:0", text: "a" },
      { wid: "0:1", text: "b" },
      { wid: "1:0", text: "c" },
    ];
    const grouped = groupByChunk(inputs);
    expect([...grouped.keys()].sort()).toEqual([0, 1]);
    expect(grouped.get(0)?.get("0:0")).toBe("a");
    expect(grouped.get(0)?.get("0:1")).toBe("b");
    expect(grouped.get(1)?.get("1:0")).toBe("c");
  });

  it("ignores a word id with no parseable chunk index", () => {
    const grouped = groupByChunk([{ wid: "not-a-wid", text: "x" }]);
    expect(grouped.size).toBe(0);
  });
});

describe("mergeScripts", () => {
  it("writes the target script onto a matching word, leaving everything else untouched", () => {
    const words = [word("0:0", "toh"), word("0:1", "aaj")];
    const patch = new Map([["0:0", "तो"]]);
    const { words: merged, changedCount } = mergeScripts(words, patch, "native");

    expect(changedCount).toBe(1);
    expect(merged[0]).toMatchObject({ t: "toh", scripts: { native: "तो" } });
    expect(merged[1]).toBe(words[1]); // untouched word: same reference
  });

  it("never touches t, s, e, sp, filler or deleted", () => {
    const original: Word = {
      wid: "0:0" as Word["wid"],
      s: 10,
      e: 20,
      t: "hai",
      sp: "s1",
      filler: true,
      deleted: false,
    };
    const { words: merged } = mergeScripts([original], new Map([["0:0", "है"]]), "native");
    expect(merged[0]).toMatchObject({
      s: 10,
      e: 20,
      t: "hai",
      sp: "s1",
      filler: true,
      deleted: false,
      scripts: { native: "है" },
    });
  });

  it("preserves an existing script slot the patch does not touch", () => {
    const original = word("0:0", "toh", { roman: "toh" });
    const { words: merged } = mergeScripts([original], new Map([["0:0", "तो"]]), "native");
    expect(merged[0]?.scripts).toEqual({ roman: "toh", native: "तो" });
  });

  it("re-writing the same text is a no-op: same array reference, zero changed", () => {
    const words = [word("0:0", "toh", { native: "तो" })];
    const { words: merged, changedCount } = mergeScripts(words, new Map([["0:0", "तो"]]), "native");
    expect(changedCount).toBe(0);
    expect(merged).toBe(words);
  });

  it("a patch naming a wid this chunk does not have changes nothing", () => {
    const words = [word("0:0", "toh")];
    const { words: merged, changedCount } = mergeScripts(words, new Map([["0:99", "x"]]), "native");
    expect(changedCount).toBe(0);
    expect(merged).toBe(words);
  });
});
