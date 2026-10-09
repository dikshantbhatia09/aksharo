/**
 * A clip's analysis as its detail view shows it (2026-10-01, from OpusClip's
 * clip view: an overall score, then Hook / Flow / Value / Trend each graded and
 * each with its reason, and "Relevant people").
 *
 * **Every grade comes from something measured or judged, never invented.**
 *
 *   * The AI editor's own 0-10 marks first (`judgement`, written while the
 *     moments are chosen): hook and trend (2026-10-01), flow = "stands on its
 *     own", value = "lands its point".
 *   * Otherwise the measured figures every moment has (`scoreBreakdown`, in
 *     percent): the opening for Hook, standing alone for Flow, clarity for
 *     Value. Trend has no measured stand-in, so a moment the AI editor gave no
 *     trend mark shows Trend only with its reason, ungraded - or not at all.
 *
 * Each part says where its grade came from (`source`), and the reason is the
 * AI editor's sentence for that part when there is one, else the moment's own
 * reason of that kind.
 */
import { clipCopyOf, judgementOf, type RepurposeCandidateItem } from "@montaj/api-client";

export type AnalysisKey = "hook" | "flow" | "value" | "trend";

export interface AnalysisPart {
  readonly key: AnalysisKey;
  readonly label: string;
  /** What the part asks, for the line under its name. */
  readonly question: string;
  /** 0-100, or null when nothing graded it. */
  readonly score: number | null;
  readonly grade: string | null;
  readonly note: string | null;
  /** "ai": the AI editor's mark; "measured": the moment's own figures. */
  readonly source: "ai" | "measured" | null;
}

export interface ClipAnalysis {
  /** The moment's potential, 0-100; null when it has none. */
  readonly overall: number | null;
  readonly parts: readonly AnalysisPart[];
  /** People the moment names or features, as the AI editor read them. */
  readonly people: readonly string[];
}

const LABELS: Readonly<Record<AnalysisKey, { readonly label: string; readonly question: string }>> =
  {
    hook: { label: "Hook", question: "Do the first seconds make people stop scrolling?" },
    flow: { label: "Flow", question: "Does it make sense on its own, start to finish?" },
    value: { label: "Value", question: "Does the viewer come away with something?" },
    trend: { label: "Trend", question: "Is it about something people are talking about now?" },
  };

/** A 0-100 score as a school grade, the way OpusClip shows its sub-scores. */
export function gradeOf(score: number): string {
  if (score >= 93) return "A+";
  if (score >= 86) return "A";
  if (score >= 80) return "A-";
  if (score >= 75) return "B+";
  if (score >= 68) return "B";
  if (score >= 60) return "B-";
  if (score >= 52) return "C+";
  if (score >= 45) return "C";
  return "D";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null;
}

function mark(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10
    ? Math.round(value * 10)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The moment's own reason of one kind; the AI editor's summary line is not one of them. */
function reasonOf(candidate: RepurposeCandidateItem, ...labels: readonly string[]): string | null {
  const reason = (candidate.reasons ?? []).find(
    (entry) => labels.includes(entry.label) && !entry.explanation.startsWith("AI editor:"),
  );
  return reason?.explanation ?? null;
}

function part(
  key: AnalysisKey,
  ai: number | null,
  measured: number | null,
  note: string | null,
): AnalysisPart | null {
  const score = ai ?? measured;
  if (score === null && note === null) return null;
  // eslint-disable-next-line security/detect-object-injection -- a closed key
  const { label, question } = LABELS[key];
  return {
    key,
    label,
    question,
    score,
    grade: score === null ? null : gradeOf(score),
    note,
    source: ai !== null ? "ai" : measured !== null ? "measured" : null,
  };
}

export function analysisOf(candidate: RepurposeCandidateItem): ClipAnalysis {
  const judgement = judgementOf(candidate.judgement);
  const raw = record(candidate.judgement);
  const notes = record(raw["notes"]);
  const measured = record(candidate["scoreBreakdown"]);
  const overall = candidate.potentialScore ?? candidate.score ?? null;

  const parts = [
    part(
      "hook",
      mark(raw["hook"]),
      percent(measured["hook"]),
      text(notes["hook"]) ?? reasonOf(candidate, "hook"),
    ),
    part(
      "flow",
      judgement === null ? null : mark(judgement.standalone),
      percent(measured["standaloneValue"]),
      text(notes["flow"]) ?? reasonOf(candidate, "standalone"),
    ),
    part(
      "value",
      judgement === null ? null : mark(judgement.payoff),
      percent(measured["clarity"]),
      text(notes["value"]) ?? reasonOf(candidate, "clear_point") ?? text(raw["why"]),
    ),
    part(
      "trend",
      mark(raw["trend"]),
      percent(measured["trend"]),
      text(notes["trend"]) ?? reasonOf(candidate, "track_record", "novelty"),
    ),
  ].filter((entry): entry is AnalysisPart => entry !== null);

  const people = Array.isArray(raw["people"])
    ? (raw["people"] as unknown[]).flatMap((name) =>
        typeof name === "string" && name.trim() !== "" ? [name.trim()] : [],
      )
    : [];

  return {
    overall: typeof overall === "number" && Number.isFinite(overall) ? Math.round(overall) : null,
    parts,
    people: people.slice(0, 5),
  };
}

const QUALITY_TAGS: Readonly<Record<string, string>> = {
  hook: "Strong hook",
  clear_point: "Clear point",
  emotion: "Emotional",
  visual: "Visual",
  novelty: "Fresh angle",
  track_record: "Like your best clips",
};

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Up to three short tags for a clip's card: what it is about (its first two
 * hashtags, written as words) and what makes it work (its strongest reason).
 */
export function tagsOf(candidate: RepurposeCandidateItem): string[] {
  const copy = clipCopyOf(candidate.copy);
  const topics = (copy?.hashtags ?? [])
    .map((tag) => tag.replace(/^#/, "").replace(/[_-]+/g, " ").trim())
    .filter((tag) => tag.length > 1 && tag.length <= 24)
    .slice(0, 2)
    .map((tag) => (/[a-z]/.test(tag) ? titleCase(tag) : tag));
  const judgement = judgementOf(candidate.judgement);
  const quality =
    judgement !== null && judgement.humour >= 6
      ? "Funny"
      : (candidate.reasons ?? [])
          .map((reason) => QUALITY_TAGS[reason.label])
          .find((tag): tag is string => tag !== undefined);
  return [...topics, ...(quality === undefined ? [] : [quality])].slice(0, 3);
}

/** Every word a person might search a clip by, lower-cased. */
export function searchTextOf(candidate: RepurposeCandidateItem): string {
  const copy = clipCopyOf(candidate.copy);
  return [
    candidate.title,
    copy?.title,
    copy?.hook,
    copy?.description,
    copy?.summary,
    ...(copy?.hashtags ?? []),
    candidate.transcriptExcerpt,
    candidate.reason,
    ...analysisOf(candidate).people,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/** Whether a clip matches a search: every word of the query somewhere in it. */
export function matchesSearch(candidate: RepurposeCandidateItem, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = searchTextOf(candidate);
  return words.every((word) => haystack.includes(word.replace(/^#/, "")));
}

export type HookCategory = "viral" | "strong" | "needs_hook";

export interface HookCategoryInfo {
  readonly category: HookCategory;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly score: number;
}

/**
 * Categorise a candidate into the editor's three distinct hook tiers:
 * 1. Viral Hook (>90%): Explosive opening that stops the scroll immediately.
 * 2. Strong Hook (70-89%): Engaging opening question or statement.
 * 3. Needs Hook Intro (<70%): High-value content, but requires an added hook in the editor.
 */
export function hookCategoryOf(candidate: RepurposeCandidateItem): HookCategoryInfo {
  const analysis = analysisOf(candidate);
  const hookPart = analysis.parts.find((p) => p.key === "hook");
  const breakdown = record(candidate["scoreBreakdown"]);
  const rawScore = hookPart?.score ?? percent(breakdown["hook"]) ?? 0;
  const score = Math.round(rawScore);

  if (score >= 90) {
    return {
      category: "viral",
      label: "Viral Hook (>90%)",
      shortLabel: "Viral Hook",
      description: "Explosive opening that stops the scroll immediately.",
      score,
    };
  }
  if (score >= 70) {
    return {
      category: "strong",
      label: "Strong Hook (70-89%)",
      shortLabel: "Strong Hook",
      description: "Engaging opening question or statement.",
      score,
    };
  }
  return {
    category: "needs_hook",
    label: "Needs Hook Intro (<70%)",
    shortLabel: "Needs Hook",
    description: "Great content, but needs an intro hook or voiceover in the editor.",
    score,
  };
}

export type ViralityTierKey = "VIRAL_GOLD" | "HIGH_POTENTIAL" | "MODERATE" | "STANDARD";

export interface ViralityTierInfo {
  readonly tier: ViralityTierKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly score: number;
}

/**
 * Classifies clips into tier categories (Pillar 2 §01):
 * - Viral Gold (85-100): Projected viral hit with strong hook & narrative.
 * - High Potential (70-84): Strong engagement drivers with high retention potential.
 * - Moderate (50-69): Solid content suitable for testing and syndication.
 * - Standard (<50): Baseline clip requiring editorial iteration.
 */
export function viralityTierOf(candidate: RepurposeCandidateItem): ViralityTierInfo {
  const rawScore = candidate.potentialScore ?? candidate.score ?? 0;
  const score = Math.round(rawScore);

  if (score >= 85) {
    return {
      tier: "VIRAL_GOLD",
      label: "Viral Gold (85-100)",
      shortLabel: "Viral Gold",
      description: "Top-tier viral hit with explosive hook and high narrative retention.",
      score,
    };
  }
  if (score >= 70) {
    return {
      tier: "HIGH_POTENTIAL",
      label: "High Potential (70-84)",
      shortLabel: "High Potential",
      description: "Strong performance indicators with high social engagement potential.",
      score,
    };
  }
  if (score >= 50) {
    return {
      tier: "MODERATE",
      label: "Moderate (50-69)",
      shortLabel: "Moderate",
      description: "Solid clip with steady engagement; consider refining hook or pacing.",
      score,
    };
  }
  return {
    tier: "STANDARD",
    label: "Standard (<50)",
    shortLabel: "Standard",
    description: "Standard moment; add a hook or punchline in the video editor.",
    score,
  };
}

