/**
 * Itemisation: cutting one word's text into runs that each have a single script
 * and a single face.
 *
 * A Hinglish caption mixes Roman and Devanagari inside a sentence and sometimes
 * inside a word ("video editing ke बारे में"), and the Latin face has no
 * Devanagari glyphs. Splitting by script first, then resolving a face per run,
 * is what stops the fallback from being decided by whichever character came
 * first.
 *
 * Neutral characters — digits, punctuation, spaces — carry no script of their
 * own, so they join the run to their left; that keeps "₹499," in one run with
 * the word it belongs to instead of orphaning the comma into its own run.
 */

import { resolveFontOrThrow } from "../fonts/registry.js";
import { codePointsOf } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { detectWordScript, type WordScript } from "../script.js";

export interface ItemisedRun {
  readonly text: string;
  readonly script: WordScript;
  readonly fontId: string;
}

export interface ItemiseOptions {
  readonly family: string;
  readonly fallbacks?: readonly string[];
  readonly weight: number;
  readonly italic: boolean;
  /** The caption's dominant script; neutral-only text is shaped with it. */
  readonly defaultScript: WordScript;
}

/** Script of a single character, or `undefined` when it is neutral. */
function scriptOfCharacter(character: string): WordScript | undefined {
  return detectWordScript(character);
}

/** Splits text into maximal same-script pieces, neutrals joining the run left. */
export function splitByScript(text: string, defaultScript: WordScript): ItemisedRun[] {
  const pieces: { text: string; script: WordScript }[] = [];
  let current: { text: string; script: WordScript } | undefined;

  for (const character of text) {
    const script = scriptOfCharacter(character);
    if (current === undefined) {
      current = { text: character, script: script ?? defaultScript };
      continue;
    }
    if (script === undefined || script === current.script) {
      current.text += character;
      continue;
    }
    pieces.push(current);
    current = { text: character, script };
  }
  if (current !== undefined) pieces.push(current);

  return pieces.map((piece) => ({ ...piece, fontId: "" }));
}

/**
 * Splits by script and resolves a face for each run. A run that the chosen
 * family cannot draw falls back through the style's `fallbacks` and then
 * through anything registered for the script (`registry.resolve`).
 */
export function itemise(
  text: string,
  registry: FontRegistry,
  options: ItemiseOptions,
): ItemisedRun[] {
  const runs: ItemisedRun[] = [];
  for (const piece of splitByScript(text, options.defaultScript)) {
    const font = resolveFontOrThrow(
      registry,
      {
        family: options.family,
        fallbacks: options.fallbacks,
        weight: options.weight,
        italic: options.italic,
        script: piece.script,
      },
      codePointsOf(piece.text),
    );
    // `splitByScript` already produced maximal same-script pieces, so adjacent
    // runs always differ in script and there is nothing left to merge.
    runs.push({ text: piece.text, script: piece.script, fontId: font.id });
  }
  return runs;
}
