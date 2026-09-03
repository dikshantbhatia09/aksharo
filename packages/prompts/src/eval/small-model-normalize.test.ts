import { describe, expect, it } from "vitest";

import {
  normalizeEditPlanOutput,
  normalizeInsightOutput,
  stripNulls,
  truncateWordBoundary,
} from "./small-model-normalize.js";

describe("stripNulls", () => {
  it("drops null-valued object keys recursively", () => {
    const raw = { a: 1, b: null, c: { d: null, e: 2 }, f: [{ g: null, h: 3 }] };
    expect(stripNulls(raw)).toEqual({ a: 1, c: { e: 2 }, f: [{ h: 3 }] });
  });

  it("leaves a null array entry alone", () => {
    expect(stripNulls({ items: [1, null, 3] })).toEqual({ items: [1, null, 3] });
  });
});

describe("truncateWordBoundary", () => {
  it("leaves short text untouched", () => {
    expect(truncateWordBoundary("short", 60)).toBe("short");
  });

  it("backs off to the last space within budget", () => {
    const text = `${"a".repeat(55)} overflow-word-that-is-long`;
    const result = truncateWordBoundary(text, 60);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toBe("a".repeat(55));
  });

  it("hard-cuts when there is no space in budget", () => {
    expect(truncateWordBoundary("a".repeat(100), 60)).toBe("a".repeat(60));
  });

  it("never returns empty for non-empty input", () => {
    const result = truncateWordBoundary("supercalifragilisticexpialidocious", 5);
    expect(result).not.toBe("");
  });
});

describe("normalizeInsightOutput", () => {
  it("truncates over-cap chapter titles", () => {
    const raw = {
      chapters: [
        { startMs: 0, title: "x".repeat(80) },
        { startMs: 1_000, title: "short title" },
      ],
    };
    const normalized = normalizeInsightOutput("chapters", raw) as {
      chapters: { title: string }[];
    };
    expect(normalized.chapters[0]?.title.length).toBeLessThanOrEqual(60);
    expect(normalized.chapters[1]?.title).toBe("short title");
  });

  it("truncates each summary field to its own cap", () => {
    const raw = { short: "s".repeat(300), medium: "m".repeat(700), long: "l".repeat(1_300) };
    const normalized = normalizeInsightOutput("summary", raw) as {
      short: string;
      medium: string;
      long: string;
    };
    expect(normalized.short.length).toBeLessThanOrEqual(240);
    expect(normalized.medium.length).toBeLessThanOrEqual(600);
    expect(normalized.long.length).toBeLessThanOrEqual(1_200);
  });

  it("truncates hooks and titles per platform", () => {
    const variant = {
      hooks: Array(5).fill("h".repeat(200)),
      titles: Array(5).fill("t".repeat(200)),
    };
    const raw = { youtube: variant, instagram: variant, tiktok: { ...variant } };
    const normalized = normalizeInsightOutput("hooks", raw) as Record<
      string,
      { hooks: string[]; titles: string[] }
    >;
    for (const variantResult of [normalized.youtube, normalized.instagram, normalized.tiktok]) {
      expect(variantResult?.hooks.every((h) => h.length <= 120)).toBe(true);
      expect(variantResult?.titles.every((t) => t.length <= 100)).toBe(true);
    }
  });

  it("truncates over-cap keyphrases", () => {
    const raw = { keyphrases: [{ phrase: "p".repeat(100), startMs: 0, endMs: 1_000 }] };
    const normalized = normalizeInsightOutput("keyphrases", raw) as {
      keyphrases: { phrase: string }[];
    };
    expect(normalized.keyphrases[0]?.phrase.length).toBeLessThanOrEqual(80);
  });

  it("sanitises hashtags to the allowed character class without inventing words", () => {
    const variant = {
      hooks: Array(5).fill("hook"),
      titles: Array(5).fill("title"),
      hashtags: ["#video-editing", "no-hash tag", "#already_ok", "#three word tag"],
    };
    const raw = { youtube: variant, instagram: { ...variant }, tiktok: { ...variant } };
    const normalized = normalizeInsightOutput("hooks", raw) as {
      youtube: { hashtags: string[] };
    };
    expect(normalized.youtube.hashtags).toEqual([
      "#videoediting",
      "#nohashtag",
      "#already_ok",
      "#threewordtag",
    ]);
  });

  it("truncates a hashtag list longer than 10 down to exactly 10, never padding a short one", () => {
    const longVariant = {
      hooks: Array(5).fill("hook"),
      titles: Array(5).fill("title"),
      hashtags: Array.from({ length: 13 }, (_, i) => `#tag${String(i)}`),
    };
    const shortVariant = { ...longVariant, hashtags: ["#onlyone"] };
    const raw = { youtube: longVariant, instagram: shortVariant, tiktok: longVariant };
    const normalized = normalizeInsightOutput("hooks", raw) as {
      youtube: { hashtags: string[] };
      instagram: { hashtags: string[] };
    };
    expect(normalized.youtube.hashtags).toHaveLength(10);
    expect(normalized.instagram.hashtags).toEqual(["#onlyone"]);
  });

  it("only strips nulls for music-mood (no string field to truncate)", () => {
    const raw = { scores: [{ index: 0, sentiment: 0.5, extra: null }] };
    expect(normalizeInsightOutput("music-mood", raw)).toEqual({
      scores: [{ index: 0, sentiment: 0.5 }],
    });
  });

  it("is a no-op for already-valid output", () => {
    const raw = { chapters: [{ startMs: 0, title: "Intro" }] };
    expect(normalizeInsightOutput("chapters", raw)).toEqual(raw);
  });
});

describe("normalizeEditPlanOutput", () => {
  it("strips a null style field", () => {
    const raw = { passes: [{ kind: "autocut", params: {} }], style: null, rationale: ["r"] };
    const normalized = normalizeEditPlanOutput(raw, "creator") as Record<string, unknown>;
    expect("style" in normalized).toBe(false);
  });

  it("truncates over-cap rationale entries", () => {
    const raw = {
      passes: [{ kind: "autocut", params: {} }],
      rationale: ["r".repeat(300)],
    };
    const normalized = normalizeEditPlanOutput(raw, "creator") as { rationale: string[] };
    expect(normalized.rationale[0]?.length).toBeLessThanOrEqual(240);
  });

  it("clamps passes to the tier cap, dropping only the lowest-priority ones, keeping matching rationale", () => {
    // creator tier caps at 4; EDIT_PLAN_PASS_KINDS priority order is
    // autocut, zoom, reframe, sfx, music, textfx -- 5 passes over a cap of
    // 4 means exactly one gets dropped: textfx, the lowest priority here.
    const raw = {
      passes: [
        { kind: "autocut", params: {} },
        { kind: "zoom", params: {} },
        { kind: "reframe", params: {} },
        { kind: "music", params: {} },
        { kind: "textfx", params: {} },
      ],
      rationale: ["a", "z", "r", "m", "t"],
    };
    const normalized = normalizeEditPlanOutput(raw, "creator") as {
      passes: { kind: string }[];
      rationale: string[];
    };
    expect(normalized.passes.map((p) => p.kind)).toEqual(["autocut", "zoom", "reframe", "music"]);
    expect(normalized.rationale).toEqual(["a", "z", "r", "m"]);
  });

  it("keeps original relative order among the kept passes", () => {
    const raw = {
      passes: [
        { kind: "textfx", params: {} },
        { kind: "autocut", params: {} },
        { kind: "sfx", params: {} },
        { kind: "reframe", params: {} },
        { kind: "music", params: {} },
      ],
      rationale: ["t", "a", "s", "r", "m"],
    };
    // free tier caps at 1 -- only the single highest-priority pass (autocut)
    // survives, wherever it sat in the model's original reply.
    const normalized = normalizeEditPlanOutput(raw, "free") as { passes: { kind: string }[] };
    expect(normalized.passes.map((p) => p.kind)).toEqual(["autocut"]);
  });

  it("leaves rationale alone when it did not line up 1:1 with passes to begin with", () => {
    const raw = {
      passes: [
        { kind: "autocut", params: {} },
        { kind: "zoom", params: {} },
        { kind: "reframe", params: {} },
        { kind: "sfx", params: {} },
        { kind: "music", params: {} },
      ],
      rationale: ["only one"],
    };
    const normalized = normalizeEditPlanOutput(raw, "creator") as {
      passes: { kind: string }[];
      rationale: string[];
    };
    expect(normalized.passes).toHaveLength(4);
    expect(normalized.rationale).toEqual(["only one"]);
  });

  it("is a no-op when the pass count is already within budget", () => {
    const raw = { passes: [{ kind: "autocut", params: {} }], rationale: ["fine"] };
    expect(normalizeEditPlanOutput(raw, "creator")).toEqual(raw);
  });

  it("trims an extra rationale entry to match the final pass count", () => {
    const raw = {
      passes: [
        { kind: "autocut", params: {} },
        { kind: "zoom", params: {} },
      ],
      rationale: ["a", "z", "one too many"],
    };
    const normalized = normalizeEditPlanOutput(raw, "creator") as { rationale: string[] };
    expect(normalized.rationale).toEqual(["a", "z"]);
  });

  it("leaves a too-short rationale alone rather than inventing an entry", () => {
    const raw = {
      passes: [
        { kind: "autocut", params: {} },
        { kind: "zoom", params: {} },
      ],
      rationale: ["only one"],
    };
    const normalized = normalizeEditPlanOutput(raw, "creator") as { rationale: string[] };
    expect(normalized.rationale).toEqual(["only one"]);
  });
});
