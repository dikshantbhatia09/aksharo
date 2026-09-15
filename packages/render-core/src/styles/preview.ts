/**
 * The three-second preview every system style ships with.
 *
 * One definition, used by three things that must agree: the animated tiles in
 * the editor's style picker, the still images the catalogue build script writes
 * to `caption-styles/previews/`, and the marketing page. If they diverged, a
 * user would pick a style from a picture the renderer never draws.
 *
 * The preview text is deliberately script-specific: a Devanagari style has to be
 * previewed in Devanagari, or the tile says nothing about the thing that is
 * actually hard.
 */

import { type RenderWord } from "../layout/types.js";
import { type WordScript } from "../script.js";

/** Every preview runs for exactly three seconds. */
export const PREVIEW_DURATION_MS = 3000;

export interface StylePreview {
  readonly segment: { readonly id: string; readonly startMs: number; readonly endMs: number };
  readonly words: readonly RenderWord[];
  readonly script: WordScript;
  /** Instants worth capturing as stills: entry, mid-word, near the exit. */
  readonly keyMs: readonly number[];
}

const PREVIEW_TEXT: Readonly<Record<WordScript, readonly string[]>> = {
  latin: ["This", "is", "how", "your", "captions", "will", "look"],
  devanagari: ["आपके", "कैप्शन", "ऐसे", "दिखेंगे", "देखिए"],
  tamil: ["உங்கள்", "வசனங்கள்", "இப்படி", "இருக்கும்"],
  other: ["This", "is", "how", "your", "captions", "will", "look"],
};

/**
 * The preview for one style. `script` picks the sample text; the timings are an
 * even split of the three seconds, which is what makes a karaoke fill or a
 * word-pop visibly move across the tile.
 */
export function previewFor(styleId: string, script: WordScript = "latin"): StylePreview {
  // eslint-disable-next-line security/detect-object-injection -- script is a renderer enum, not an arbitrary input key.
  const defaultTexts = PREVIEW_TEXT[script];
  const texts =
    styleId.startsWith("editorial-") && script === "latin"
      ? ["Make", "your", "captions", "feel", "alive"]
      : defaultTexts;
  const span = PREVIEW_DURATION_MS / texts.length;
  return {
    segment: { id: `preview:${styleId}`, startMs: 0, endMs: PREVIEW_DURATION_MS },
    script,
    words: texts.map((text, index) => ({
      wid: `preview:${String(index)}`,
      t: text,
      s: Math.round(span * index),
      e: Math.round(span * (index + 1)),
      sp: "sp1",
    })),
    // Late enough for the entry to have finished, mid-caption, and just before
    // the exit begins — the three moments a still has to be honest about.
    keyMs: [
      Math.round(PREVIEW_DURATION_MS * 0.25),
      Math.round(PREVIEW_DURATION_MS * 0.5),
      Math.round(PREVIEW_DURATION_MS * 0.8),
    ],
  };
}

/** The still a catalogue tile shows: the middle key instant. */
export function previewStillMs(): number {
  return Math.round(PREVIEW_DURATION_MS * 0.5);
}

/** The scripts a style catalogue previews in. */
export const PREVIEW_SCRIPTS: readonly WordScript[] = ["latin", "devanagari", "tamil"];
