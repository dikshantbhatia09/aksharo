/**
 * The fake/mock LLM provider the eval runner and CI use — no network, no key
 * (brief §6: "eval runner executed with the fake provider in CI"). It builds
 * schema-valid output deterministically FROM the transcript itself, which is
 * also what makes the hallucination guard meaningful: everything it emits is
 * lifted from the transcript's own words, so a real check of "no invented
 * proper nouns" is exercised even though nothing was actually generated.
 *
 * `apps/worker-ai/worker_ai/llm/providers/mock.py` is the Python mirror this
 * one is modelled on, for the same worker-side unit tests.
 */
import { maxChaptersFor } from "../templates/chapters.js";
import { transcriptVocabulary } from "../templates/common.js";
import { HOOK_PLATFORMS } from "../templates/hooks.js";
import { SUMMARY_MAX_CHARS } from "../templates/summary.js";

import type { ChaptersInput, ChaptersOutput } from "../templates/chapters.js";
import type { HooksInput, HooksOutput } from "../templates/hooks.js";
import type { KeyphrasesInput, KeyphrasesOutput } from "../templates/keyphrases.js";
import type { InsightKind } from "../templates/registry.js";
import type { SummaryInput, SummaryOutput } from "../templates/summary.js";
import type { PromptTranscriptInput } from "../templates/types.js";

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function mockChapters(input: ChaptersInput): ChaptersOutput {
  const cap = Math.min(maxChaptersFor(input.durationMs), input.segments.length);
  const stride = Math.max(1, Math.floor(input.segments.length / cap));
  const chapters: ChaptersOutput["chapters"] = [];
  for (const [i, segment] of input.segments.entries()) {
    if (chapters.length >= cap) break;
    if (i % stride !== 0) continue;
    chapters.push({
      startMs: segment.startMs,
      title: clip(segment.text || `Chapter ${String(chapters.length + 1)}`, 60),
    });
  }
  const first = input.segments[0];
  if (chapters.length === 0 && first !== undefined) {
    chapters.push({ startMs: first.startMs, title: clip(first.text, 60) });
  }
  return { chapters };
}

export function mockSummary(input: SummaryInput): SummaryOutput {
  const full = input.segments.map((s) => s.text).join(" ");
  return {
    short: clip(full, SUMMARY_MAX_CHARS.short),
    medium: clip(full, SUMMARY_MAX_CHARS.medium),
    long: clip(full, SUMMARY_MAX_CHARS.long),
  };
}

export function mockHooks(input: HooksInput): HooksOutput {
  const vocab = [...transcriptVocabulary(input as PromptTranscriptInput)].filter(
    (w) => w.length > 1,
  );
  const words = vocab.length > 0 ? vocab : ["clip"];
  const pick = (n: number): string => words[n % words.length] ?? "clip";
  const result = {} as Record<(typeof HOOK_PLATFORMS)[number], HooksOutput["youtube"]>;
  for (const platform of HOOK_PLATFORMS) {
    const hooks = Array.from({ length: 5 }, (_, i) =>
      clip(`${pick(i)} ${pick(i + 1)} ${pick(i + 2)}`, 120),
    );
    const titles = Array.from({ length: 5 }, (_, i) => clip(`${pick(i + 3)} ${pick(i + 4)}`, 100));
    const hashtags = Array.from(
      { length: 10 },
      (_, i) => `#${pick(i + 5).replace(/[^\p{L}\p{N}_]/gu, "")}`,
    ).map((tag, i) => (tag === "#" ? `#tag${String(i)}` : tag));
    result[platform] = { hooks, titles, hashtags };
  }
  return result as HooksOutput;
}

export function mockKeyphrases(input: KeyphrasesInput): KeyphrasesOutput {
  const keyphrases = input.segments.slice(0, input.maxPhrases).map((segment) => ({
    phrase: clip(segment.text.split(/\s+/).slice(0, 4).join(" ") || "phrase", 80),
    startMs: segment.startMs,
    endMs: segment.endMs,
  }));
  return { keyphrases };
}

export function mockGenerate(kind: InsightKind, input: unknown): unknown {
  switch (kind) {
    case "chapters":
      return mockChapters(input as ChaptersInput);
    case "summary":
      return mockSummary(input as SummaryInput);
    case "hooks":
      return mockHooks(input as HooksInput);
    default: {
      const exhaustive: never = kind;
      throw new Error(`no mock generator for ${String(exhaustive)}`);
    }
  }
}
