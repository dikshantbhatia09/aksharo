import { describe, expect, it } from "vitest";

import { chaptersTemplate, maxChaptersFor } from "./chapters.js";
import { hooksTemplate } from "./hooks.js";
import { keyphrasesTemplate } from "./keyphrases.js";
import { musicMoodTemplate } from "./music-mood.js";
import { allTemplates, templateFor, TEMPLATE_REGISTRY } from "./registry.js";
import { summaryTemplate } from "./summary.js";

const SAMPLE_INPUT = {
  language: "en",
  mediaTitle: "Sample",
  durationMs: 20_000,
  segments: [
    { startMs: 0, endMs: 4_000, text: "Hello everyone welcome to the show" },
    { startMs: 4_000, endMs: 8_000, text: "Today we talk about testing" },
  ],
};

describe("template registry", () => {
  it("has one entry per kind, each snapshot-stable on version", () => {
    expect(Object.keys(TEMPLATE_REGISTRY).sort()).toEqual([
      "chapters",
      "hooks",
      "keyphrases",
      "musicMood",
      "summary",
    ]);
    expect(chaptersTemplate.version).toBe("chapters@1");
    expect(summaryTemplate.version).toBe("summary@1");
    expect(hooksTemplate.version).toBe("hooks@1");
    expect(keyphrasesTemplate.version).toBe("keyphrases@1");
    expect(musicMoodTemplate.version).toBe("music-mood@1");
  });

  it("resolves by kind", () => {
    expect(templateFor("chapters")).toBe(chaptersTemplate);
    expect(allTemplates()).toHaveLength(5);
  });

  it("every template builds non-empty system/user messages that fence the transcript as data", () => {
    for (const template of allTemplates()) {
      const input = template.inputSchema.parse(SAMPLE_INPUT);
      const messages = template.build(input);
      expect(messages.system.length).toBeGreaterThan(0);
      expect(messages.user).toContain("<transcript>");
      expect(messages.user).toContain("Hello everyone");
    }
  });
});

describe("maxChaptersFor", () => {
  it("caps at 12 for <= 30 minutes", () => {
    expect(maxChaptersFor(10 * 60_000)).toBe(12);
    expect(maxChaptersFor(30 * 60_000)).toBe(12);
  });

  it("grows for longer media, capped at 24", () => {
    expect(maxChaptersFor(40 * 60_000)).toBe(13);
    expect(maxChaptersFor(300 * 60_000)).toBe(24);
  });
});

describe("chapters output schema", () => {
  it("rejects unordered chapters", () => {
    const result = chaptersTemplate.outputSchema.safeParse({
      chapters: [
        { startMs: 5_000, title: "B" },
        { startMs: 1_000, title: "A" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a title over 60 chars", () => {
    const result = chaptersTemplate.outputSchema.safeParse({
      chapters: [{ startMs: 0, title: "x".repeat(61) }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid chapter list", () => {
    const result = chaptersTemplate.outputSchema.safeParse({
      chapters: [
        { startMs: 0, title: "Intro" },
        { startMs: 4_000, title: "Main topic" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("hooks output schema", () => {
  const validVariant = {
    hooks: ["a", "b", "c", "d", "e"],
    titles: ["a", "b", "c", "d", "e"],
    hashtags: Array.from({ length: 10 }, (_, i) => `#tag${String(i)}`),
  };

  it("requires exactly 5 hooks, 5 titles, 10 hashtags per platform", () => {
    const result = hooksTemplate.outputSchema.safeParse({
      youtube: validVariant,
      instagram: validVariant,
      tiktok: validVariant,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a hashtag with a space", () => {
    const bad = { ...validVariant, hashtags: [...validVariant.hashtags.slice(0, 9), "#bad tag"] };
    const result = hooksTemplate.outputSchema.safeParse({
      youtube: bad,
      instagram: validVariant,
      tiktok: validVariant,
    });
    expect(result.success).toBe(false);
  });
});

describe("music-mood output schema", () => {
  it("accepts a valid score list", () => {
    const result = musicMoodTemplate.outputSchema.safeParse({
      scores: [
        { index: 0, sentiment: 0.5 },
        { index: 1, sentiment: -0.2 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a sentiment outside [-1, 1]", () => {
    const result = musicMoodTemplate.outputSchema.safeParse({
      scores: [{ index: 0, sentiment: 2 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate segment index", () => {
    const result = musicMoodTemplate.outputSchema.safeParse({
      scores: [
        { index: 0, sentiment: 0.1 },
        { index: 0, sentiment: -0.1 },
      ],
    });
    expect(result.success).toBe(false);
  });
});
