/**
 * D06b count-up number formatting.
 *
 * A `count-up` title's text carries its target number inline (`"50,000 creators"`,
 * `"₹12L saved"`) rather than as a separate manifest field (`TitleTrackSchema`
 * has only `text`, D06); this module finds that number and substitutes the
 * animated value `textFxPhase`'s `countFraction` sweeps from 0 up to it,
 * formatted with the digits and grouping the title's own script would use —
 * Devanagari digits for a Hindi/Marathi title, Tamil digits for a Tamil one —
 * so a "locale-aware digits for hi/mr/ta etc" title counts up in its own
 * numerals rather than always in Western Arabic ones.
 */

import { type WordScript } from "../script.js";
import { clamp01 } from "../units.js";

/** The first run of digits (with optional thousands separators) in `text`. */
const NUMBER_PATTERN = /\d[\d,]*/;

/** BCP-47 tag `Intl.NumberFormat` uses to pick digits for one script. */
function localeFor(script: WordScript | undefined): string {
  switch (script) {
    case "devanagari":
      return "hi-u-nu-deva";
    case "tamil":
      return "ta-u-nu-tamldec";
    default:
      return "en";
  }
}

/** Formats `value` with the digits/grouping a script's own numerals use. */
export function formatLocaleNumber(
  value: number,
  script: WordScript | undefined,
  useGrouping: boolean,
): string {
  return new Intl.NumberFormat(localeFor(script), { useGrouping }).format(value);
}

/**
 * Replaces the first number in `text` with `fraction` of its own value
 * (rounded, never negative), re-formatted in the script's own digits and with
 * the same grouping the source text used. Text with no number in it is
 * returned unchanged — a `count-up` preset applied to a non-numeric title is
 * not this module's problem to solve.
 */
export function countUpText(
  text: string,
  fraction: number,
  script: WordScript | undefined,
): string {
  const match = NUMBER_PATTERN.exec(text);
  if (match === null) return text;
  const raw = match[0];
  const target = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(target)) return text;
  const shown = Math.round(target * clamp01(fraction));
  const formatted = formatLocaleNumber(shown, script, raw.includes(","));
  return text.slice(0, match.index) + formatted + text.slice(match.index + raw.length);
}
