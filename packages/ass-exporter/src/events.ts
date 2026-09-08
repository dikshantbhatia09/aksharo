/**
 * Segments → `[Events]` `Dialogue:` lines.
 *
 * `\pos` is derived from the same anchor point `render-core`'s `layoutSegment`
 * resolves a caption's box against — `layout.x`/`layout.y` (already normalised
 * 0–1 canvas coordinates) times the canvas — which is the "layout-derived
 * `\pos`" the brief asks for. It is the caption's anchor, not a per-glyph
 * position: exact per-word glyph boxes need HarfBuzz shaping, which this
 * package does not run (`toAss` is synchronous and takes no shaper). A caller
 * that already has a `render-core` `Layout` for a caption (the parity gate
 * does) can widen this later; today every event anchors at the style's own
 * point, which is exactly what libass's own `\an`/`\pos` alignment model
 * expects.
 */

import { resolveColour, type StyleDoc } from "@montaj/caption-styles";
import type { TimeQuery } from "@montaj/timemap";

import { toAssColourNoAlpha } from "./colour.js";
import { toAssTimestamp, toKaraokeCentis } from "./time.js";

import type { AssWarning } from "./capabilities.js";
import type { AssSegment, AssWord, ToAssOptions } from "./types.js";

/** Escapes text for the ASS `Text` field: literal braces and newlines only. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

export interface AssDialogueEvent {
  readonly styleId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly line: string;
}

interface WordSpan {
  readonly word: AssWord;
  readonly text: string;
}

function wordText(word: AssWord, script: ToAssOptions["script"]): string {
  if (script === undefined || script === "roman") return word.t;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return word.scripts?.[script] ?? word.t;
}

function posTag(style: StyleDoc, canvas: { width: number; height: number }): string {
  const x = Math.round(style.layout.x * canvas.width);
  const y = Math.round(style.layout.y * canvas.height);
  return `\\pos(${String(x)},${String(y)})`;
}

function remap(
  startMs: number,
  endMs: number,
  timemap: TimeQuery | null | undefined,
): readonly { readonly startMs: number; readonly endMs: number }[] {
  if (timemap === null || timemap === undefined) return [{ startMs, endMs }];
  return timemap
    .mapRange(startMs, endMs)
    .map((range) => ({ startMs: range.outputStart, endMs: range.outputEnd }));
}

/** Words visible for one segment, filtered and script-resolved, in order. */
export function wordsFor(
  segment: AssSegment,
  words: readonly AssWord[],
  dropFillers: boolean,
): AssWord[] {
  const start = words.findIndex((word) => word.wid === segment.startWordId);
  if (start < 0) return [];
  const endIndex = words.findIndex(
    (word, index) => index >= start && word.wid === segment.endWordId,
  );
  const slice = words.slice(start, endIndex < 0 ? words.length : endIndex + 1);
  return slice.filter((word) => word.deleted !== true && (!dropFillers || word.filler !== true));
}

/**
 * One caption as ASS `Dialogue:` lines. Normally one line per output range
 * (a segment straddling a cut becomes two); `perWordPositions` or a non-`none`,
 * non-`karaoke-fill` word highlight instead emits one event per word, which is
 * the deterministic degradation `capabilities.ts` documents.
 */
export function buildSegmentEvents(
  segment: AssSegment,
  style: StyleDoc,
  allWords: readonly AssWord[],
  opts: ToAssOptions,
  warnings: AssWarning[],
): AssDialogueEvent[] {
  if (segment.hidden === true) return [];
  const dropFillers = opts.dropFillers ?? false;
  const words = wordsFor(segment, allWords, dropFillers);
  if (words.length === 0) return [];

  const override = segment.textOverrides?.[opts.script ?? "roman"];
  const canvas = opts.canvas ?? { width: 1080, height: 1920 };
  const highlight = style.animation.wordHighlight.type;
  const scriptOfWords = wordsSpan(words, opts.script);

  const ranges = remap(segment.startMs, segment.endMs, opts.timemap);
  const events: AssDialogueEvent[] = [];

  for (const range of ranges) {
    if (override !== undefined && override !== "") {
      events.push(oneLineEvent(style, range.startMs, range.endMs, escapeAssText(override), canvas));
      continue;
    }

    if (highlight === "karaoke-fill") {
      if (!isLatinScript(scriptOfWords)) {
        warnings.push({
          code: "karaoke_non_latin_disabled",
          message: `karaoke-fill disabled for non-Latin script on segment ${segment.id}; falling back to plain text`,
          context: segment.id,
        });
        events.push(plainLineEvent(style, range, words, opts, canvas));
      } else {
        events.push(karaokeEvent(style, range, words, opts, canvas));
      }
      continue;
    }

    if (highlight === "none") {
      events.push(plainLineEvent(style, range, words, opts, canvas));
      continue;
    }

    // color / scale / underline / glow / box(word): one event per word.
    warnings.push({
      code: highlight === "glow" ? "glow_reduced_to_outline" : "word_highlight_per_word_events",
      message: `${highlight} word highlight on segment ${segment.id} degrades to one ASS event per word`,
      context: segment.id,
    });
    events.push(...perWordEvents(style, range, words, opts, canvas));
  }

  return events;
}

function wordsSpan(words: readonly AssWord[], script: ToAssOptions["script"]): string {
  return words.map((word) => wordText(word, script)).join(" ");
}

const LATIN_RE = /^[\s\p{Script=Latin}\p{P}\p{N}]*$/u;
function isLatinScript(text: string): boolean {
  return LATIN_RE.test(text);
}

function oneLineEvent(
  style: StyleDoc,
  startMs: number,
  endMs: number,
  text: string,
  canvas: { width: number; height: number },
): AssDialogueEvent {
  const line =
    `Dialogue: 0,${toAssTimestamp(startMs)},${toAssTimestamp(endMs)},${style.id},,0,0,0,,` +
    `{${posTag(style, canvas)}}${text}`;
  return { styleId: style.id, startMs, endMs, line };
}

function plainLineEvent(
  style: StyleDoc,
  range: { startMs: number; endMs: number },
  words: readonly AssWord[],
  opts: ToAssOptions,
  canvas: { width: number; height: number },
): AssDialogueEvent {
  const text = escapeAssText(words.map((word) => wordText(word, opts.script)).join(" "));
  return oneLineEvent(style, range.startMs, range.endMs, text, canvas);
}

function karaokeEvent(
  style: StyleDoc,
  range: { startMs: number; endMs: number },
  words: readonly AssWord[],
  opts: ToAssOptions,
  canvas: { width: number; height: number },
): AssDialogueEvent {
  const body = words
    .map((word) => {
      const durationCs = toKaraokeCentis(Math.max(0, word.e - word.s));
      return `{\\kf${String(durationCs)}}${escapeAssText(wordText(word, opts.script))}`;
    })
    .join(" ");
  return oneLineEvent(style, range.startMs, range.endMs, body, canvas);
}

function perWordEvents(
  style: StyleDoc,
  range: { startMs: number; endMs: number },
  words: readonly AssWord[],
  opts: ToAssOptions,
  canvas: { width: number; height: number },
): AssDialogueEvent[] {
  const highlight = style.animation.wordHighlight.type;
  const restColour =
    style.colors.upcomingText !== undefined ? toAssColourNoAlpha(style.colors.upcomingText) : null;
  // A `Gradient` `colors.text` (K08) resolves to its first stop — see
  // `style-map.ts`'s `buildStyleLine` for the same fallback and why.
  const activeColour = toAssColourNoAlpha(
    resolveColour(style.colors.activeText ?? style.colors.accent ?? style.colors.text),
  );

  return words.map((word) => {
    const wordSpan: WordSpan = { word, text: wordText(word, opts.script) };
    const overlapsRange = word.s < range.endMs && word.e > range.startMs;
    const tags: string[] = [posTag(style, canvas)];
    if (overlapsRange) {
      if (highlight === "color" || highlight === "glow") tags.push(`\\1c${activeColour}`);
      if (highlight === "underline") tags.push("\\u1");
      if (highlight === "scale") {
        const scale = Math.round((style.animation.wordHighlight.scale ?? 1.15) * 100);
        tags.push(`\\fscx${String(scale)}\\fscy${String(scale)}`);
      }
      if (highlight === "glow") tags.push("\\be1");
    } else if (restColour !== null) {
      tags.push(`\\1c${restColour}`);
    }
    const text = `{${tags.join("")}}${escapeAssText(wordSpan.text)}`;
    return oneLineEvent(style, range.startMs, range.endMs, text, canvas);
  });
}
