import type { Word } from "@montaj/edg/schemas";
import { dominantScript } from "@montaj/edg/segmenter";

/**
 * Two-signal language identification (D14).
 *
 * One signal is never enough for the languages this product exists for. A
 * provider asked to transcribe Hinglish answers `hi` (it heard Hindi) or `en` (it
 * heard English words) and both are half right; what the caption pipeline needs
 * to know is which **script** the words are written in, because that is what
 * decides the line length, the reading speed and the font.
 *
 * So the verdict is built from two independent signals:
 *
 * * **acoustic** — what the ASR provider said, with its own confidence;
 * * **orthographic** — the Unicode block the words actually landed in, which is
 *   the segmenter's own `dominantScript` so the two can never disagree about what
 *   a Devanagari word is.
 *
 * They are combined into a BCP-47 tag with a script subtag where the script is
 * not the language's default: Hindi in Roman letters is `hi-Latn` (Hinglish),
 * Hindi in Devanagari is plain `hi`. Both signals are recorded in
 * `transcripts.detected_languages` — a disagreement is information, and A10's
 * alignment and B09's memory both want to see it rather than a single flattened
 * answer.
 */

export interface DetectedLanguage {
  /** BCP-47 tag. */
  readonly language: string;
  /** 0–1. The provider's own figure, or the share of words the script covers. */
  readonly confidence: number;
  readonly source: "provider" | "script";
}

export interface LanguageVerdict {
  /** The tag written to `transcripts.language` and `EdgHot.transcript.language`. */
  readonly language: string;
  /** Both signals, provider first. */
  readonly detected: readonly DetectedLanguage[];
  /** Script slots present on the words: what `EdgHot.transcript.scripts` carries. */
  readonly scripts: readonly ("roman" | "native" | "en")[];
  /** True when the two signals disagreed and the script won. */
  readonly disagreed: boolean;
}

/** Scripts whose own language default is Latin. */
const LATIN_DEFAULT = new Set(["en", "de", "fr", "es", "pt", "it", "nl", "id", "ms", "sw"]);

/** The script subtag for what the segmenter detected. */
function subtagFor(script: string): string | undefined {
  switch (script) {
    case "latin":
      return "Latn";
    case "devanagari":
      return "Deva";
    case "tamil":
      return "Taml";
    default:
      return undefined;
  }
}

/** Does the tag already name a script? */
function hasScriptSubtag(language: string): boolean {
  return language
    .split("-")
    .slice(1)
    .some((part) => part.length === 4);
}

/**
 * Combine the provider's answer with the script the words are written in.
 *
 * `providerLanguages` is what the worker reported, if anything; `providerLanguage`
 * is `result.language`, which A09 always sends.
 */
export function identifyLanguage(input: {
  readonly words: readonly Word[];
  readonly providerLanguage: string;
  readonly providerConfidence?: number;
  readonly providerLanguages?: readonly DetectedLanguage[];
  /** A caller-supplied hint always wins: the user told us. */
  readonly hint?: string;
}): LanguageVerdict {
  const texts = input.words.map((word) => word.t);
  const script = dominantScript(texts);
  const subtag = subtagFor(script);

  const base = (input.providerLanguage.split("-")[0] ?? input.providerLanguage).toLowerCase();
  const scriptIsDefault =
    subtag === undefined ||
    (script === "latin" && LATIN_DEFAULT.has(base)) ||
    (script === "devanagari" && ["hi", "mr", "ne", "sa", "bho", "mai"].includes(base)) ||
    (script === "tamil" && base === "ta");

  const fromScript = scriptIsDefault || base === "" ? base : `${base}-${subtag}`;
  const resolved =
    input.hint !== undefined && input.hint !== ""
      ? input.hint
      : hasScriptSubtag(input.providerLanguage)
        ? input.providerLanguage
        : fromScript;

  const scriptShare = shareOfScript(texts, script);
  const detected: DetectedLanguage[] = [
    {
      language: input.providerLanguage,
      confidence: clamp(input.providerConfidence ?? 0.5),
      source: "provider",
    },
    { language: fromScript, confidence: clamp(scriptShare), source: "script" },
  ];

  for (const extra of input.providerLanguages ?? []) {
    if (detected.some((entry) => entry.language === extra.language)) continue;
    detected.push({ ...extra, confidence: clamp(extra.confidence) });
  }

  return {
    language: resolved === "" ? "en" : resolved,
    detected,
    scripts: scriptSlots(input.words),
    disagreed: fromScript !== input.providerLanguage,
  };
}

/** Which of `roman`/`native`/`en` any word actually carries (CONTRACTS §2). */
export function scriptSlots(words: readonly Word[]): ("roman" | "native" | "en")[] {
  const slots = new Set<"roman" | "native" | "en">();
  for (const word of words) {
    for (const key of ["roman", "native", "en"] as const) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      if (word.scripts?.[key] !== undefined) slots.add(key);
    }
  }
  // A transcript with no per-script spellings still has the one it is written in.
  if (slots.size === 0) {
    slots.add(dominantScript(words.map((word) => word.t)) === "latin" ? "roman" : "native");
  }
  return [...slots];
}

/** Share of the words the dominant script actually covers: the script signal's confidence. */
function shareOfScript(texts: readonly string[], script: string): number {
  const lettered = texts.filter((text) => /\p{L}/u.test(text));
  if (lettered.length === 0) return 0;
  const matching = lettered.filter((text) => dominantScript([text]) === script).length;
  return matching / lettered.length;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}
