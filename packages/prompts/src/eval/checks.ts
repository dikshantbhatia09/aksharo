/**
 * Automatic checks the eval runner applies to every (fixture, template)
 * output (brief §1): schema validity, timestamp validity/ordering, the
 * hallucination guard, length limits and language consistency.
 *
 * Each check returns `{ok, detail}` rather than throwing — the runner keeps
 * going and reports every failure for a fixture, not just the first.
 */
import { maxChaptersFor } from "../templates/chapters.js";
import { transcriptVocabulary } from "../templates/common.js";

import type { ChaptersOutput } from "../templates/chapters.js";
import type { HooksOutput } from "../templates/hooks.js";
import type { InsightKind } from "../templates/registry.js";
import type { SummaryOutput } from "../templates/summary.js";
import type { PromptTranscriptInput } from "../templates/types.js";
import type { z } from "zod";

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Words that are always allowed even if absent from the transcript: platform boilerplate. */
const HASHTAG_ALLOWLIST = new Set(["fyp", "viral", "reels", "shorts", "trending", "explore"]);

function scriptOf(text: string): "latin" | "devanagari" | "tamil" | "other" {
  if (/[ऀ-ॿ]/.test(text)) return "devanagari";
  if (/[஀-௿]/.test(text)) return "tamil";
  if (/[A-Za-z]/.test(text)) return "latin";
  return "other";
}

function expectedScript(language: string): "latin" | "devanagari" | "tamil" | "other" {
  if (language === "hi") return "devanagari";
  if (language === "ta") return "tamil";
  return "latin"; // en, hi-Latn (Hinglish stays in Latin script)
}

export function checkSchema<T>(schema: z.ZodType<T>, output: unknown): CheckResult {
  const parsed = schema.safeParse(output);
  return {
    name: "schema_validity",
    ok: parsed.success,
    detail: parsed.success ? "output matches the template's output schema" : parsed.error.message,
  };
}

export function checkTimestamps(kind: InsightKind, output: unknown, durationMs: number): CheckResult {
  if (kind === "chapters") {
    const chapters = (output as ChaptersOutput).chapters;
    const cap = maxChaptersFor(durationMs);
    if (chapters.length > cap) {
      return { name: "timestamp_validity", ok: false, detail: `${String(chapters.length)} chapters exceeds cap ${String(cap)}` };
    }
    let previousStartMs: number | undefined;
    for (const [i, c] of chapters.entries()) {
      if (c.startMs < 0 || c.startMs > durationMs) {
        return { name: "timestamp_validity", ok: false, detail: `chapter ${String(i)} startMs ${String(c.startMs)} out of range [0, ${String(durationMs)}]` };
      }
      if (previousStartMs !== undefined && c.startMs <= previousStartMs) {
        return { name: "timestamp_validity", ok: false, detail: `chapter ${String(i)} not strictly after chapter ${String(i - 1)}` };
      }
      previousStartMs = c.startMs;
    }
    return { name: "timestamp_validity", ok: true, detail: `${String(chapters.length)} chapters, ordered, within duration` };
  }
  return { name: "timestamp_validity", ok: true, detail: "not applicable to this kind" };
}

/** No proper noun (capitalised token) absent from the transcript's own vocabulary. */
export function checkHallucination(kind: InsightKind, output: unknown, transcript: PromptTranscriptInput): CheckResult {
  const vocab = transcriptVocabulary(transcript);
  const strings: string[] = [];
  if (kind === "chapters") {
    strings.push(...(output as ChaptersOutput).chapters.map((c) => c.title));
  } else if (kind === "summary") {
    const s = output as SummaryOutput;
    strings.push(s.short, s.medium, s.long);
  } else if (kind === "hooks") {
    const h = output as HooksOutput;
    for (const variant of Object.values(h)) {
      strings.push(...variant.hooks, ...variant.titles, ...variant.hashtags.map((t) => t.replace(/^#/, "")));
    }
  }
  const offenders: string[] = [];
  for (const text of strings) {
    for (const token of text.split(/[^\p{L}\p{N}']+/u)) {
      if (token.length < 2) continue;
      const isCapitalised = /^[A-Z]/.test(token);
      if (!isCapitalised) continue;
      const lower = token.toLowerCase();
      if (vocab.has(lower) || HASHTAG_ALLOWLIST.has(lower)) continue;
      offenders.push(token);
    }
  }
  return {
    name: "hallucination_guard",
    ok: offenders.length === 0,
    detail: offenders.length === 0 ? "no invented proper nouns" : `possible invented terms: ${offenders.join(", ")}`,
  };
}

export function checkLengths(kind: InsightKind, output: unknown): CheckResult {
  if (kind === "chapters") {
    const bad = (output as ChaptersOutput).chapters.filter((c) => c.title.length > 60);
    return { name: "length_limits", ok: bad.length === 0, detail: bad.length === 0 ? "all titles <= 60 chars" : `${String(bad.length)} titles over 60 chars` };
  }
  return { name: "length_limits", ok: true, detail: "enforced by schema (max())" };
}

export function checkLanguageConsistency(kind: InsightKind, output: unknown, language: string): CheckResult {
  const expected = expectedScript(language);
  const strings: string[] = [];
  if (kind === "chapters") strings.push(...(output as ChaptersOutput).chapters.map((c) => c.title));
  else if (kind === "summary") {
    const s = output as SummaryOutput;
    strings.push(s.short, s.medium, s.long);
  } else if (kind === "hooks") {
    const h = output as HooksOutput;
    for (const variant of Object.values(h)) strings.push(...variant.hooks, ...variant.titles);
  }
  const combined = strings.join(" ");
  const actual = scriptOf(combined);
  const ok = actual === expected || actual === "other";
  return {
    name: "language_consistency",
    ok,
    detail: ok ? `script matches expected (${expected})` : `expected ${expected} script for "${language}", got ${actual}`,
  };
}

export function runChecks<T>(
  kind: InsightKind,
  schema: z.ZodType<T>,
  output: unknown,
  transcript: PromptTranscriptInput,
): readonly CheckResult[] {
  const schemaResult = checkSchema(schema, output);
  if (!schemaResult.ok) {
    // Every other check assumes shape; stop here rather than throwing inside them.
    return [schemaResult];
  }
  return [
    schemaResult,
    checkTimestamps(kind, output, transcript.durationMs),
    checkHallucination(kind, output, transcript),
    checkLengths(kind, output),
    checkLanguageConsistency(kind, output, transcript.language),
  ];
}
