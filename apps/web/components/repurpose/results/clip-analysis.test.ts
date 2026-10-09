import { describe, expect, it } from "vitest";

import type { RepurposeCandidateItem } from "@montaj/api-client";

import {
  analysisOf,
  diagnosticCategoryIcon,
  diagnosticCategoryLabel,
  diagnosticSentimentTone,
  fallbackDiagnostic,
  gradeOf,
  matchesSearch,
  tagsOf,
  viralityTierOf,
} from "./clip-analysis";

const COPY = {
  summary: "Why insecurity fades",
  hook: "Stop trying to impress",
  cta: "",
  hashtags: ["#seduction", "#confidence", "#mindset"],
  locale: "en-IN",
  title: "How to overcome insecurity",
};

function candidate(over: Partial<RepurposeCandidateItem> = {}): RepurposeCandidateItem {
  return {
    id: "C1",
    startMs: 94_000,
    endMs: 124_000,
    potentialScore: 85,
    title: "Raw title",
    copy: COPY,
    transcriptExcerpt: "Insecure people focus on themselves; confident people focus on you.",
    reasons: [
      {
        label: "standalone",
        explanation: "AI editor: A clear point. (stands on its own 7/10, lands its point 6/10).",
      },
      { label: "hook", explanation: "Opens with 'how', a hook in the first seconds." },
      {
        label: "standalone",
        explanation: "Starts and ends on complete sentences, so it stands on its own.",
      },
      {
        label: "clear_point",
        explanation: "Dense, fluent speech: 105 words in 36 s with no fillers.",
      },
    ],
    scoreBreakdown: { hook: 70, clarity: 100, standaloneValue: 77, novelty: 0, emotion: 0 },
    ...over,
  };
}

describe("gradeOf", () => {
  it("grades like a report card", () => {
    expect([95, 88, 82, 76, 70, 61, 55, 46, 20].map(gradeOf)).toEqual([
      "A+",
      "A",
      "A-",
      "B+",
      "B",
      "B-",
      "C+",
      "C",
      "D",
    ]);
  });
});

describe("analysisOf", () => {
  it("prefers the AI editor's marks and notes, part by part", () => {
    const analysis = analysisOf(
      candidate({
        judgement: {
          standalone: 7,
          payoff: 9,
          humour: 1,
          hook: 8,
          trend: 6,
          notes: { hook: "Opens on a sharp question.", trend: "Dating advice is widely shared." },
          people: ["Robert Greene", "Raj Shamani"],
          model: "m",
        },
      }),
    );
    expect(analysis.overall).toBe(85);
    expect(analysis.parts.map((part) => [part.key, part.score, part.grade, part.source])).toEqual([
      ["hook", 80, "A-", "ai"],
      ["flow", 70, "B", "ai"],
      ["value", 90, "A", "ai"],
      ["trend", 60, "B-", "ai"],
    ]);
    expect(analysis.parts[0]?.note).toBe("Opens on a sharp question.");
    // No AI note for flow: the moment's own reason of that kind, never the summary line.
    expect(analysis.parts[1]?.note).toBe(
      "Starts and ends on complete sentences, so it stands on its own.",
    );
    expect(analysis.people).toEqual(["Robert Greene", "Raj Shamani"]);
  });

  it("falls back to the measured figures, and shows no Trend it has nothing for", () => {
    const analysis = analysisOf(candidate());
    expect(analysis.parts.map((part) => [part.key, part.score, part.source])).toEqual([
      ["hook", 70, "measured"],
      ["flow", 77, "measured"],
      ["value", 100, "measured"],
    ]);
    expect(analysis.people).toEqual([]);
  });

  it("keeps an ungraded Trend when the moment has a reason for it", () => {
    const analysis = analysisOf(
      candidate({
        reasons: [{ label: "track_record", explanation: "Like your clips that did best." }],
      }),
    );
    expect(analysis.parts.find((part) => part.key === "trend")).toMatchObject({
      score: null,
      grade: null,
      note: "Like your clips that did best.",
    });
  });
});

describe("tagsOf", () => {
  it("names what it is about, then what makes it work", () => {
    expect(tagsOf(candidate())).toEqual(["Seduction", "Confidence", "Strong hook"]);
  });

  it("calls a funny one funny", () => {
    expect(
      tagsOf(
        candidate({ copy: {}, judgement: { standalone: 5, payoff: 5, humour: 8, model: "m" } }),
      ),
    ).toEqual(["Funny"]);
  });
});

describe("matchesSearch", () => {
  it("finds a clip by its words, its title, its topics or a name", () => {
    const one = candidate({
      judgement: { standalone: 5, payoff: 5, humour: 0, people: ["Robert Greene"], model: "m" },
    });
    expect(matchesSearch(one, "confident")).toBe(true);
    expect(matchesSearch(one, "overcome insecurity")).toBe(true);
    expect(matchesSearch(one, "#mindset")).toBe(true);
    expect(matchesSearch(one, "greene")).toBe(true);
    expect(matchesSearch(one, "cooking")).toBe(false);
    expect(matchesSearch(one, "  ")).toBe(true);
  });
});

describe("viralityTierOf", () => {
  it("classifies candidates into universal virality tiers", () => {
    expect(viralityTierOf(candidate({ potentialScore: 92 }))).toMatchObject({
      tier: "VIRAL_GOLD",
      shortLabel: "Viral Gold",
      score: 92,
    });
    expect(viralityTierOf(candidate({ potentialScore: 78 }))).toMatchObject({
      tier: "HIGH_POTENTIAL",
      shortLabel: "High Potential",
      score: 78,
    });
    expect(viralityTierOf(candidate({ potentialScore: 62 }))).toMatchObject({
      tier: "MODERATE",
      shortLabel: "Moderate",
      score: 62,
    });
    expect(viralityTierOf(candidate({ potentialScore: 41 }))).toMatchObject({
      tier: "STANDARD",
      shortLabel: "Standard",
      score: 41,
    });
  });
});

describe("ViralityDiagnostic", () => {
  it("parses explicit candidate diagnostic when present", () => {
    const item = candidate({
      diagnostic: {
        overallSummary: "Explosive opening with high emotional tension.",
        items: [
          {
            category: "HOOK",
            label: "Provocative Hook",
            detail: "Opens with an intriguing question.",
            sentiment: "POSITIVE",
          },
          {
            category: "FLOW",
            label: "Seamless Delivery",
            detail: "Transitions cleanly without dead air.",
            sentiment: "POSITIVE",
          },
        ],
        creatorTip: "Add a punch-in camera zoom on second 03.",
      },
    });

    const analysis = analysisOf(item);
    expect(analysis.diagnostic).not.toBeNull();
    expect(analysis.diagnostic?.overallSummary).toBe(
      "Explosive opening with high emotional tension.",
    );
    expect(analysis.diagnostic?.items).toHaveLength(2);
    expect(analysis.diagnostic?.items[0]?.category).toBe("HOOK");
    expect(analysis.diagnostic?.items[0]?.sentiment).toBe("POSITIVE");
    expect(analysis.diagnostic?.creatorTip).toBe("Add a punch-in camera zoom on second 03.");
  });

  it("synthesizes fallback diagnostic when candidate lacks explicit diagnostic", () => {
    const item = candidate({
      diagnostic: null,
      scoreBreakdown: { hook: 88, clarity: 95, standaloneValue: 80 },
      reasons: [
        { label: "hook", explanation: "Opens with a direct call to action." },
        { label: "standalone", explanation: "Complete thought from start to finish." },
        { label: "clear_point", explanation: "Crystal clear delivery." },
      ],
    });

    const fallback = fallbackDiagnostic(item);
    expect(fallback).not.toBeNull();
    expect(fallback?.items.length).toBeGreaterThanOrEqual(3);
    const hookItem = fallback?.items.find((i) => i.category === "HOOK");
    expect(hookItem?.sentiment).toBe("POSITIVE");
    expect(hookItem?.detail).toBe("Opens with a direct call to action.");
    expect(fallback?.creatorTip).toBeDefined();

    const analysis = analysisOf(item);
    expect(analysis.diagnostic).toEqual(fallback);
  });

  it("returns null fallback diagnostic when candidate has no reasons or breakdown", () => {
    const emptyCandidate = candidate({
      diagnostic: null,
      reasons: [],
      scoreBreakdown: {},
    });
    expect(fallbackDiagnostic(emptyCandidate)).toBeNull();
  });

  it("maps sentiment tones and category labels correctly", () => {
    expect(diagnosticSentimentTone("POSITIVE")).toBe("accepted");
    expect(diagnosticSentimentTone("WARNING")).toBe("warning");
    expect(diagnosticSentimentTone("NEUTRAL")).toBe("neutral");

    expect(diagnosticCategoryLabel("HOOK")).toBe("Hook");
    expect(diagnosticCategoryLabel("FLOW")).toBe("Flow");
    expect(diagnosticCategoryLabel("EMOTION")).toBe("Emotion");
    expect(diagnosticCategoryLabel("TREND")).toBe("Trend");
    expect(diagnosticCategoryLabel("RETENTION")).toBe("Retention");

    expect(diagnosticCategoryIcon("HOOK")).toBe("🎣");
    expect(diagnosticCategoryIcon("FLOW")).toBe("🌊");
    expect(diagnosticCategoryIcon("EMOTION")).toBe("💥");
    expect(diagnosticCategoryIcon("TREND")).toBe("📈");
    expect(diagnosticCategoryIcon("RETENTION")).toBe("⏱️");
  });
});


