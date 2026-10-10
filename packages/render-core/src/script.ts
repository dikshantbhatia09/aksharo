/**
 * Script rules are owned by `@montaj/edg/segmenter` and re-exported here so the
 * renderer cannot drift from the segmenter.
 *
 * The rule that matters (orchestrator addendum, 2026-09-02): a character budget
 * counts **base code points with combining marks excluded**, which is
 * grapheme-equivalent for Indic scripts. The segmenter has already limited a
 * caption to `maxLines` lines of 32/24/22 characters (Latin/Devanagari/Tamil);
 * layout wraps with the same counter so it reproduces the segmenter's own line
 * split instead of inventing a different one.
 */

export {
  charCount,
  detectWordScript,
  dominantScript,
  limitsFor,
  SCRIPT_LIMITS,
  type ScriptLimits,
  type WordScript,
} from "@montaj/edg/segmenter";

import { type WordScript } from "@montaj/edg/segmenter";

/**
 * The OpenType script tag HarfBuzz should shape a run with. Passing it
 * explicitly (rather than letting `guessSegmentProperties` sniff) keeps shaping
 * deterministic across HarfBuzz builds.
 */
export function openTypeScriptTag(script: WordScript | string, text?: string): string {
  const normalized = script.toLowerCase();
  switch (normalized) {
    case "devanagari":
    case "deva":
    case "hi":
      return "Deva";
    case "tamil":
    case "taml":
    case "ta":
      return "Taml";
    case "telugu":
    case "telu":
    case "te":
      return "Telu";
    case "kannada":
    case "knda":
    case "kn":
      return "Knda";
    case "bengali":
    case "beng":
    case "bn":
      return "Beng";
    case "malayalam":
    case "mlym":
    case "ml":
      return "Mlym";
    case "gujarati":
    case "gujr":
    case "gu":
      return "Gujr";
    case "gurmukhi":
    case "guru":
    case "pa":
      return "Guru";
    case "odia":
    case "oriya":
    case "orya":
    case "or":
      return "Orya";
    case "latin":
    case "latn":
    case "en":
      return "Latn";
    default: {
      if (text) {
        for (const char of text) {
          const code = char.codePointAt(0) ?? 0;
          if (code >= 0x0900 && code <= 0x097f) return "Deva";
          if (code >= 0x0980 && code <= 0x09ff) return "Beng";
          if (code >= 0x0a00 && code <= 0x0a7f) return "Guru";
          if (code >= 0x0a80 && code <= 0x0aff) return "Gujr";
          if (code >= 0x0b00 && code <= 0x0b7f) return "Orya";
          if (code >= 0x0b80 && code <= 0x0bff) return "Taml";
          if (code >= 0x0c00 && code <= 0x0c7f) return "Telu";
          if (code >= 0x0c80 && code <= 0x0cff) return "Knda";
          if (code >= 0x0d00 && code <= 0x0d7f) return "Mlym";
        }
      }
      return "Zyyy";
    }
  }
}


/**
 * The key a `typography.scriptScale` entry is stored under: the lowercase
 * OpenType tag. Lowercase because a JSON key is data, and `deva` reads better
 * in a document than `Deva`.
 */
export function scriptScaleKey(script: WordScript): string {
  return openTypeScriptTag(script).toLowerCase();
}

/**
 * The per-script multiplier on a style's `sizePct`, or 1 when the document says
 * nothing. Latin keeps the size the style was drawn for; Indic scripts take the
 * size a full-budget line of their own needs.
 */
export function scriptScaleFor(
  scriptScale: Readonly<Record<string, number | undefined>> | undefined,
  script: WordScript,
): number {
  const scale = scriptScale?.[scriptScaleKey(script)];
  return scale === undefined || !Number.isFinite(scale) || scale <= 0 ? 1 : scale;
}

/**
 * Whether a script needs cluster-aware treatment: reordered matras, conjuncts
 * and mark positioning mean a break may only fall on a cluster boundary and a
 * "character" is not a code point.
 */
export function isComplexScript(script: WordScript): boolean {
  return script === "devanagari" || script === "tamil" || script === "other";
}
