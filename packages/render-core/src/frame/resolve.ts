/**
 * Resolving a caption's *effective* style and text.
 *
 * Three layers, applied in this order (CONTRACTS §2 `SetStyle`):
 *
 * 1. the catalogue style — `Segment.styleRef`, falling back to
 *    `EdgHot.styles.defaultStyleId`;
 * 2. the **document** overrides at `styles.inline.doc` — one `SetStyle` with
 *    `scope: "doc"` writes here, so a user who nudges the size once changes
 *    every caption;
 * 3. the segment's own `overrides`, which win.
 *
 * Text follows the same idea: a word carries `scripts` (Roman, native, English)
 * and a segment may carry a whole-line `textOverrides` entry that replaces them.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { RenderError } from "../errors.js";
import { type RenderWord } from "../layout/types.js";

/** The script a caption is displayed in; matches `Word.scripts`' keys. */
export type DisplayScript = "roman" | "native" | "en";

/** A partial StyleDoc, as `styles.inline.doc` and `Segment.overrides` carry. */
export type StyleOverrides = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge with the override winning at every leaf. Arrays replace rather
 * than concatenate — an override that lists two emphasis presets means two, not
 * "the style's three plus these".
 */
export function mergeOverrides<T>(base: T, overrides: StyleOverrides | undefined): T {
  if (overrides === undefined) return base;
  if (!isPlainObject(base)) return (overrides as unknown) as T;
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? mergeOverrides(current, value) : value;
  }
  return result as unknown as T;
}

export interface StyleSource {
  /** The catalogue: system styles plus any workspace presets. */
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly defaultStyleId: string;
  /** `EdgHot.styles.inline.doc`. */
  readonly documentOverrides?: StyleOverrides;
}

/**
 * The effective style for one segment. Results are memoised per
 * (styleId, overrides) pair because a 30-second caption track re-resolves the
 * same handful of styles thirty times a second.
 */
export function resolveStyle(
  source: StyleSource,
  segment: { readonly styleRef?: string; readonly overrides?: StyleOverrides },
  cache?: Map<string, StyleDoc>,
): StyleDoc {
  const styleId = segment.styleRef ?? source.defaultStyleId;
  const base = source.catalogue.get(styleId);
  if (base === undefined) {
    throw new RenderError("render/unknown-style", `style "${styleId}" is not in the catalogue`, {
      styleId,
      known: source.catalogue.size,
    });
  }
  const documentOverrides = source.documentOverrides;
  if (documentOverrides === undefined && segment.overrides === undefined) return base;

  const key = `${styleId}|${JSON.stringify(documentOverrides ?? null)}|${JSON.stringify(segment.overrides ?? null)}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;

  const merged = mergeOverrides(mergeOverrides(base, documentOverrides), segment.overrides);
  cache?.set(key, merged);
  return merged;
}

/** A transcript word as `@montaj/edg` stores it (CONTRACTS §2). */
export interface TranscriptWord {
  readonly wid: string;
  readonly s: number;
  readonly e: number;
  readonly t: string;
  readonly sp?: string;
  readonly scripts?: Partial<Record<DisplayScript, string>>;
  readonly deleted?: boolean;
  readonly filler?: boolean;
}

export interface ResolveTextOptions {
  readonly segment: {
    readonly id: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly textOverrides?: Record<string, string>;
    readonly emphasis?: readonly { readonly wordId: string; readonly presetId: string }[];
  };
  readonly words: readonly TranscriptWord[];
  readonly script: DisplayScript;
  /** Leave words tagged as filler out of the caption. */
  readonly dropFillers?: boolean;
}

/**
 * The display words for one segment.
 *
 * A `textOverrides` entry replaces the whole caption for that script. When the
 * override has exactly as many whitespace-separated tokens as the segment has
 * words, timings are kept word for word — so a corrected transliteration still
 * karaokes correctly. Otherwise the segment's duration is split evenly across
 * the tokens, which is the only honest thing to do once the mapping is gone.
 */
export function resolveWords(options: ResolveTextOptions): RenderWord[] {
  const { segment, script } = options;
  const emphasis = new Map((segment.emphasis ?? []).map((entry) => [entry.wordId, entry.presetId]));

  const live = options.words.filter(
    (word) => word.deleted !== true && (options.dropFillers !== true || word.filler !== true),
  );

  const override = segment.textOverrides?.[script];
  if (override === undefined) {
    return live.map((word) => {
      const text = word.scripts?.[script] ?? word.t;
      const presetId = emphasis.get(word.wid);
      return {
        wid: word.wid,
        t: text,
        s: word.s,
        e: word.e,
        ...(word.sp === undefined ? {} : { sp: word.sp }),
        ...(presetId === undefined ? {} : { emphasisPresetId: presetId }),
      };
    });
  }

  const tokens = override.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  if (tokens.length === live.length) {
    return live.map((word, index) => {
      const presetId = emphasis.get(word.wid);
      return {
        wid: word.wid,
        t: tokens[index] ?? word.t,
        s: word.s,
        e: word.e,
        ...(word.sp === undefined ? {} : { sp: word.sp }),
        ...(presetId === undefined ? {} : { emphasisPresetId: presetId }),
      };
    });
  }

  const span = Math.max(1, segment.endMs - segment.startMs);
  const speaker = live[0]?.sp;
  return tokens.map((token, index) => ({
    wid: `${segment.id}#${String(index)}`,
    t: token,
    s: segment.startMs + Math.round((span * index) / tokens.length),
    e: segment.startMs + Math.round((span * (index + 1)) / tokens.length),
    ...(speaker === undefined ? {} : { sp: speaker }),
  }));
}
