import { describe, expect, it } from "vitest";

import {
  assertCompliantStyleName,
  DENYLIST,
  DENYLIST_TOKENS,
  findNamingViolations,
  isCompliantStyleName,
  nameTokens,
  StyleNamingError,
} from "./naming.js";

describe("style naming rule (D64)", () => {
  it("rejects the creator name and accepts the look name", () => {
    expect(isCompliantStyleName({ id: "hormozi-pop", name: "Hormozi Pop" })).toBe(false);
    expect(isCompliantStyleName({ id: "punch-pop", name: "Punch Pop" })).toBe(true);
  });

  it("names the field and the token it matched", () => {
    expect(findNamingViolations({ id: "hormozi-pop", name: "Punch Pop" })).toEqual([
      { field: "id", token: "hormozi", match: "word" },
    ]);
    // One name can break the rule twice: "MrBeast" is a whole-word hit on
    // `mrbeast` and a substring hit on `beast`.
    expect(findNamingViolations({ id: "punch-pop", name: "MrBeast Style" })).toEqual([
      { field: "name", token: "mrbeast", match: "word" },
      { field: "name", token: "beast", match: "substring" },
    ]);
  });

  it("carries the deny-list tokens the brief requires", () => {
    for (const token of [
      "hormozi",
      "mrbeast",
      "beast",
      "kalakar",
      "captik",
      "pause",
      "submagic",
      "capcut",
      "tiktok",
      "instagram",
      "youtube",
      "reels",
      "shorts",
    ]) {
      expect(DENYLIST_TOKENS, `deny-list is missing ${token}`).toContain(token);
    }
    expect(DENYLIST.version).toBe(1);
    expect(DENYLIST.tokens.length).toBeGreaterThanOrEqual(13);
  });

  it("catches a token hidden inside a longer word", () => {
    expect(findNamingViolations({ id: "beastmode-bold" })).toEqual([
      { field: "id", token: "beast", match: "substring" },
    ]);
    expect(findNamingViolations({ name: "Captikish" })).toEqual([
      { field: "name", token: "captik", match: "substring" },
    ]);
  });

  it("does not match short tokens inside longer words", () => {
    // A four-letter token would flag "metallic"; only whole-word hits count for it.
    expect(findNamingViolations({ id: "metallic-sweep" }, ["meta"])).toEqual([]);
    expect(findNamingViolations({ id: "meta-sweep" }, ["meta"])).toEqual([
      { field: "id", token: "meta", match: "word" },
    ]);
  });

  it("ignores fields that are not strings", () => {
    expect(findNamingViolations({ id: 7, name: undefined })).toEqual([]);
  });

  it("splits names into comparable words", () => {
    expect(nameTokens("Hype Bold — v2")).toEqual(["hype", "bold", "v2"]);
  });

  it("accepts an admin-extended deny-list", () => {
    expect(isCompliantStyleName({ id: "sunset-fade" })).toBe(true);
    expect(isCompliantStyleName({ id: "sunset-fade" }, [...DENYLIST_TOKENS, "sunset"])).toBe(false);
  });

  it("throws with every violation attached", () => {
    expect(() => assertCompliantStyleName({ id: "punch-pop" })).not.toThrow();
    try {
      assertCompliantStyleName({ id: "capcut-clean", name: "CapCut Clean" });
      expect.unreachable("expected StyleNamingError");
    } catch (error) {
      expect(error).toBeInstanceOf(StyleNamingError);
      expect((error as StyleNamingError).violations).toHaveLength(2);
      expect((error as StyleNamingError).message).toMatch(/D64/);
    }
  });
});
