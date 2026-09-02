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
export function openTypeScriptTag(script: WordScript): string {
  switch (script) {
    case "devanagari":
      return "Deva";
    case "tamil":
      return "Taml";
    case "latin":
      return "Latn";
    default:
      return "Zyyy";
  }
}

/**
 * Whether a script needs cluster-aware treatment: reordered matras, conjuncts
 * and mark positioning mean a break may only fall on a cluster boundary and a
 * "character" is not a code point.
 */
export function isComplexScript(script: WordScript): boolean {
  return script === "devanagari" || script === "tamil" || script === "other";
}
