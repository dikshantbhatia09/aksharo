import { describe, expect, it } from "vitest";

import type { HighlightProposal } from "@montaj/repurpose-contracts";

import { candidateModelFields, clipCopyOf } from "./clip-copy.js";

const COPY = {
  summary: "Salary badhne par bhi paise kyun nahi bachte.",
  hook: "Yeh galti sab karte hain",
  cta: "Poora video zaroor dekhiye.",
  hashtags: ["#money", "#paisa", "#बचत"],
  locale: "hi-Latn",
  title: "Salary se ameer kyun nahi bante?",
  description: "Savings ki sabse badi galti.",
  platforms: { x: { text: "Salary se ameer kyun nahi bante? #money" } },
  source: "model" as const,
};

function proposal(extra: Partial<HighlightProposal> = {}): HighlightProposal {
  return {
    windowId: "w-00001",
    startMs: 0,
    endMs: 30_000,
    startWordId: "a",
    endWordId: "b",
    title: "yeh sabse badi galti hai jo log",
    transcriptExcerpt: "yeh sabse badi galti hai jo log salary ke saath karte hain",
    potentialScore: 72,
    scoreBreakdown: {
      hook: 50,
      clarity: 50,
      emotion: 50,
      visualActivity: 50,
      novelty: 50,
      standaloneValue: 50,
      safety: 100,
    },
    reasons: [{ label: "standalone", explanation: "AI editor: Clear rule." }],
    ...extra,
  };
}

describe("candidateModelFields", () => {
  it("titles the candidate by its copy and keeps the copy and the judgement", () => {
    const judgement = { standalone: 8, payoff: 7, humour: 1, model: "sarvam-105b-conversations" };
    const fields = candidateModelFields(proposal({ copy: COPY, judgement }));
    expect(fields).toEqual({ title: COPY.title, copy: COPY, judgement });
  });

  it("keeps the moment's own title, and writes neither, when the model wrote none", () => {
    expect(candidateModelFields(proposal())).toEqual({ title: "yeh sabse badi galti hai jo log" });
  });

  it("keeps the moment's title when the copy has none", () => {
    const { title: _title, ...untitled } = COPY;
    expect(candidateModelFields(proposal({ copy: untitled })).title).toBe(
      "yeh sabse badi galti hai jo log",
    );
  });
});

describe("clipCopyOf", () => {
  it("starts a clip from its candidate's whole copy", () => {
    expect(clipCopyOf({ copy: COPY })).toEqual(COPY);
  });

  it("starts a clip with no copy when the candidate has none, or only part of one", () => {
    expect(clipCopyOf({ copy: {} })).toBeUndefined();
    expect(clipCopyOf({ copy: { title: "only a title" } })).toBeUndefined();
    expect(clipCopyOf({ copy: { ...COPY, hashtags: ["#two words"] } })).toBeUndefined();
    expect(clipCopyOf({ copy: null })).toBeUndefined();
  });
});
