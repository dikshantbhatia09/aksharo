/**
 * The hook title (2026-09-29): a title card over the first seconds of a clip —
 * the line that makes a viewer stay past the first three seconds. It lives on
 * the document as an overlay (`EdgHot.overlays`, kind `hook-title`), on the
 * source clock like a caption, and this module is the one place it becomes
 * pixels, so the editor preview, the browser export, the cloud render and the
 * share viewer all draw the same card.
 *
 * **What it looks like.** The words in the document style's own typeface, a
 * heavier weight of it, in its own letter case, on a solid rounded card in the
 * style's highlight colour (its `activeText`, else its `accent`, else white)
 * with black or white ink, whichever reads on that card. A soft shadow lifts
 * the card off a bright frame. It drops in over a third of a second and fades
 * out at the end of its window.
 *
 * **Where it goes.** Centred, near the top: below the part of a vertical frame
 * the platforms cover with their own chrome. It never covers a face (from the
 * same `faces.json` track the captions use, with a smaller allowance above the
 * head: covering a little hair is fine, covering a forehead is not) and never
 * covers a caption shown while it is up. In that order it:
 *
 * 1. sits in the top slot at full size, or a little smaller (down to 75 %);
 * 2. failing that, sits just below whatever blocks the top slot, at those sizes,
 *    as long as it stays in the upper 70 % of the frame;
 * 3. failing that, shrinks to 60 % in either place;
 * 4. and if nothing clears everything (a face filling the frame), it takes the
 *    top slot at 60 % anyway — a hook that disappears is worse than one that
 *    brushes a head.
 *
 * Placement is worked out once per overlay (per projection, per canvas, per
 * face track) and kept for every frame the title is up, like a caption's.
 *
 * Pure: the same inputs give the same `DrawCommand[]` on every backend.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { lerp, easeInCubic, easeOutBack, easeOutCubic } from "../animate/easing.js";
import { contrastingInk, setAlpha } from "../colour.js";
import {
  fill,
  group,
  roundRect,
  scaleTranslateMatrix,
  shadow,
  text,
  transform,
} from "../commands/build.js";
import { type DrawCommand, type GlyphRun, type Rect } from "../commands/types.js";
import { isRenderError } from "../errors.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type CanvasFaceTrack, facesDuring, type FacePadding } from "../frame/placement.js";
import { applyTextTransform, layoutSegment } from "../layout/layout.js";
import { type Layout, type PlacedRun, type RenderWord } from "../layout/types.js";
import { charCount } from "../script.js";
import { assertCanvas, type CanvasSize, clamp01, q } from "../units.js";

/** The one overlay kind so far (`@montaj/edg` `OverlayKind`). */
export const HOOK_TITLE_KIND = "hook-title";

/**
 * An overlay as the projection hands it over (`EdgHot.overlays`), on the
 * source clock like a segment.
 */
export interface OverlayTrack {
  readonly id: string;
  readonly kind: typeof HOOK_TITLE_KIND;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Type size as a share of the canvas's short side, so every shape reads alike. */
export const HOOK_TITLE_SIZE = 0.085;
/** A hook is a line or two; three is the most that still reads in two seconds. */
const MAX_LINES = 3;
const LINE_HEIGHT = 1.1;
/** Card padding and corner radius, in em. */
const PAD_X_EM = 0.42;
const PAD_Y_EM = 0.28;
const RADIUS_EM = 0.3;
/** The widest the card may get: most of a vertical frame, less of a wide one. */
const MAX_WIDTH_PORTRAIT_PCT = 86;
const MAX_WIDTH_LANDSCAPE_PCT = 64;
/**
 * Clear of the platform's own chrome at the top of a vertical frame (Reels,
 * Shorts and TikTok put their labels and buttons there); a square or wide
 * frame keeps an ordinary margin.
 */
const TOP_MARGIN_PORTRAIT = 0.09;
const MARGIN_OF_SHORT_SIDE = 0.06;
/** The card never reaches below this share of the frame: the captions live there. */
const LOWEST_BOTTOM = 0.7;
/** Air between the card and a face or caption it moved off, share of height. */
const GAP = 0.015;
/** A face is avoided with less hair allowance than a caption gets (`placement.ts`). */
const HOOK_FACE_PADDING: FacePadding = { above: 0.12, below: 0.05, sides: 0.06 };

/** The sizes tried in each slot before the next one, then the last resort. */
const PREFERRED_SCALES = [1, 0.9, 0.8, 0.75] as const;
const LAST_SCALES = [0.7, 0.6] as const;
export const MIN_HOOK_TITLE_SCALE = 0.6;

const ENTER_MS = 320;
const EXIT_MS = 220;

/** A laid-out, placed hook title: what `drawHookTitle` draws, frame after frame. */
export interface HookTitleLayout {
  readonly overlayId: string;
  /** The words, placed at their final position. */
  readonly layout: Layout;
  /** The card behind them. */
  readonly card: Rect;
  readonly cardColour: string;
  readonly inkColour: string;
  /** 1 at full size; smaller when it had to shrink to clear a face or a caption. */
  readonly scale: number;
}

export interface HookTitleInput {
  readonly overlay: OverlayTrack;
  /** The document's own style (its default, with document overrides applied). */
  readonly style: StyleDoc;
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** Where the faces are, mapped onto the canvas; absent means none to avoid. */
  readonly faces?: CanvasFaceTrack;
  /** What the captions cover while the title is up, in canvas pixels. */
  readonly captions?: readonly Rect[];
}

/** The overlay's words, all on screen for its whole window. */
function wordsOf(overlay: OverlayTrack): RenderWord[] {
  return overlay.text
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word, index) => ({
      wid: `${overlay.id}:${String(index)}`,
      t: word,
      s: overlay.startMs,
      e: overlay.endMs,
    }));
}

function isPortrait(canvas: CanvasSize): boolean {
  return canvas.height > canvas.width * 1.1;
}

/**
 * The style the words are laid out with: the document's typeface, heavier, at
 * the title's size, centred, with none of a caption's behaviour (word chunks,
 * one word at a time, editorial compositions, its own box) — the card is drawn
 * here, not by the caption's box.
 */
function titleStyleOf(style: StyleDoc, canvas: CanvasSize, scale: number): StyleDoc {
  const fontPx = Math.min(canvas.width, canvas.height) * HOOK_TITLE_SIZE * scale;
  const { typographyMotion: _motion, ...animation } = style.animation;
  return {
    ...style,
    typography: {
      ...style.typography,
      weight: Math.min(900, Math.max(800, style.typography.weight)),
      sizePct: (fontPx / canvas.height) * 100,
      lineHeight: LINE_HEIGHT,
      underline: false,
      strikethrough: false,
    },
    box: { ...style.box, enabled: false },
    layout: {
      anchor: "top-center",
      x: 0.5,
      y: 0,
      align: "center",
      maxWidthPct: isPortrait(canvas) ? MAX_WIDTH_PORTRAIT_PCT : MAX_WIDTH_LANDSCAPE_PCT,
      maxLines: MAX_LINES,
      safeAreaPct: 0,
    },
    animation: { ...animation, perWord: false },
    emphasisPresets: [],
  };
}

interface Measured {
  readonly scale: number;
  /** What is laid out: the words, or one token per balanced line. */
  readonly tokens: readonly RenderWord[];
  /** `1` when each token is a line of its own ({@link measure}). */
  readonly maxChars: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly padX: number;
  readonly padY: number;
}

/**
 * Lays the tokens out with `inkTop` as the top of the first line's letters.
 * `maxChars` narrows the character wrap; see {@link measure}.
 */
function layOut(
  input: HookTitleInput,
  tokens: readonly RenderWord[],
  scale: number,
  inkTop: number,
  maxChars: number | undefined,
): Layout {
  const { overlay, canvas } = input;
  return layoutSegment({
    style: titleStyleOf(input.style, canvas, scale),
    segment: {
      id: overlay.id,
      startMs: overlay.startMs,
      endMs: overlay.endMs,
      position: { x: 0.5, y: inkTop / canvas.height, anchor: "top-center" },
    },
    words: tokens,
    canvas,
    registry: input.registry,
    shaper: input.shaper,
    tMs: overlay.startMs,
    ...(maxChars === undefined ? {} : { maxChars }),
  });
}

/**
 * Where to break `counts` (characters per word) into exactly `lines` lines so
 * the longest line is as short as it can be, and among those the lines are as
 * even as they can be. Exhaustive: a hook is a handful of words and three lines
 * at most, so there are a few hundred splits at worst.
 *
 * @returns the index of the first word of each line after the first.
 */
export function balancedBreaks(counts: readonly number[], lines: number): number[] {
  const words = counts.length;
  if (lines <= 1 || words <= 1) return [];
  const want = Math.min(lines, words);
  let best: { breaks: number[]; longest: number; spread: number } | undefined;
  const lengthOf = (from: number, to: number): number => {
    let total = to - from - 1;
    for (let index = from; index < to; index += 1) total += counts.at(index) ?? 0;
    return total;
  };
  const visit = (from: number, left: number, breaks: number[]): void => {
    if (left === 1) {
      const all = [0, ...breaks, words];
      const lengths = all.slice(1).map((to, index) => lengthOf(all.at(index) ?? 0, to));
      const longest = Math.max(...lengths);
      const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
      const spread = lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0);
      if (
        best === undefined ||
        longest < best.longest ||
        (longest === best.longest && spread < best.spread)
      ) {
        best = { breaks: [...breaks], longest, spread };
      }
      return;
    }
    for (let next = from + 1; next <= words - (left - 1); next += 1) {
      visit(next, left - 1, [...breaks, next]);
    }
  };
  visit(0, want, []);
  return best?.breaks ?? [];
}

/**
 * The card's size at `scale`. A title reads better as lines of even length
 * than as a full line and a straggler, which is what a greedy wrap leaves: so
 * once the words need more than one line, the same number of lines is chosen
 * by {@link balancedBreaks} and each line is laid out as one token on a line
 * of its own. Kept only when it needs no more shrinking than the plain wrap.
 */
function measure(input: HookTitleInput, words: readonly RenderWord[], scale: number): Measured {
  let layout = layOut(input, words, scale, 0, undefined);
  let tokens: readonly RenderWord[] = words;
  let maxChars: number | undefined;
  if (layout.lines.length > 1 && words.length > layout.lines.length) {
    const transform = input.style.typography.textTransform;
    const counts = words.map((word) => charCount(applyTextTransform(word.t, transform)));
    const breaks = balancedBreaks(counts, layout.lines.length);
    const starts = [0, ...breaks];
    const lineTokens = starts.map((from, index) => {
      const to = starts.at(index + 1) ?? words.length;
      const first = words.at(from);
      return {
        wid: first?.wid ?? `${input.overlay.id}:${String(from)}`,
        t: words
          .slice(from, to)
          .map((word) => word.t)
          .join(" "),
        s: input.overlay.startMs,
        e: input.overlay.endMs,
      };
    });
    const balanced = layOut(input, lineTokens, scale, 0, 1);
    if (balanced.lines.length === layout.lines.length && balanced.shrink >= layout.shrink) {
      layout = balanced;
      tokens = lineTokens;
      maxChars = 1;
    }
  }
  const padX = PAD_X_EM * layout.fontSizePx;
  const padY = PAD_Y_EM * layout.fontSizePx;
  return {
    scale,
    tokens,
    maxChars,
    width: layout.box[2] - layout.box[0] + 2 * padX,
    height: layout.box[3] - layout.box[1] + 2 * padY,
    padX,
    padY,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** The card's highlight colour, opaque: a card you can see through is not a card. */
function cardColourOf(style: StyleDoc): string {
  return setAlpha(style.colors.activeText ?? style.colors.accent ?? "#ffffff", 1);
}

/**
 * Lays out and places one hook title ({@link HookTitleLayout}), or `undefined`
 * when it has no words. Throws what `layoutSegment` throws (a face that covers
 * none of the text); {@link renderHookTitles} turns that into "not drawn".
 */
export function layoutHookTitle(input: HookTitleInput): HookTitleLayout | undefined {
  const canvas = assertCanvas(input.canvas);
  const words = wordsOf(input.overlay);
  if (words.length === 0) return undefined;

  const shortSide = Math.min(canvas.width, canvas.height);
  const topMargin = isPortrait(canvas)
    ? canvas.height * TOP_MARGIN_PORTRAIT
    : shortSide * MARGIN_OF_SHORT_SIDE;
  const lowest = canvas.height * LOWEST_BOTTOM;
  const gap = canvas.height * GAP;

  const obstacles: Rect[] = [
    ...(input.faces === undefined
      ? []
      : facesDuring(
          input.faces,
          input.overlay.startMs,
          input.overlay.endMs,
          canvas,
          HOOK_FACE_PADDING,
        )),
    ...(input.captions ?? []),
  ];
  // The top slot, then just below each thing that could block it.
  const below = [
    ...new Set(obstacles.map((box) => q(box[3] + gap)).filter((top) => top > topMargin)),
  ].sort((a, b) => a - b);

  const measured = new Map<number, Measured>();
  const sizeAt = (scale: number): Measured => {
    let found = measured.get(scale);
    if (found === undefined) {
      found = measure(input, words, scale);
      measured.set(scale, found);
    }
    return found;
  };
  const cardAt = (top: number, size: Measured): Rect => [
    (canvas.width - size.width) / 2,
    top,
    (canvas.width + size.width) / 2,
    top + size.height,
  ];
  const fits = (top: number, scale: number): boolean => {
    const card = cardAt(top, sizeAt(scale));
    return card[3] <= lowest && !obstacles.some((box) => overlaps(box, card));
  };

  const stages: readonly { tops: readonly number[]; scales: readonly number[] }[] = [
    { tops: [topMargin], scales: PREFERRED_SCALES },
    { tops: below, scales: PREFERRED_SCALES },
    { tops: [topMargin, ...below], scales: LAST_SCALES },
  ];
  let chosen: { top: number; scale: number } | undefined;
  search: for (const stage of stages) {
    for (const top of stage.tops) {
      for (const scale of stage.scales) {
        if (fits(top, scale)) {
          chosen = { top, scale };
          break search;
        }
      }
    }
  }
  chosen ??= { top: topMargin, scale: MIN_HOOK_TITLE_SCALE };

  const size = sizeAt(chosen.scale);
  const layout = layOut(input, size.tokens, chosen.scale, chosen.top + size.padY, size.maxChars);
  const card: Rect = [
    q(layout.box[0] - size.padX),
    q(layout.box[1] - size.padY),
    q(layout.box[2] + size.padX),
    q(layout.box[3] + size.padY),
  ];
  const cardColour = cardColourOf(input.style);
  return {
    overlayId: input.overlay.id,
    layout,
    card,
    cardColour,
    inkColour: contrastingInk(cardColour),
    scale: chosen.scale,
  };
}

/** Where a hook title is in its entry and exit at one instant. */
export interface HookTitlePhase {
  readonly opacity: number;
  readonly scale: number;
  /** Vertical offset in em of the title's own type size; negative is up. */
  readonly dyEm: number;
}

/**
 * The card drops in (a short fall from above, a slight overshoot in size) and
 * fades out at the end of its window. Short windows scale both down so a card
 * is never all entry and exit.
 */
export function hookTitlePhase(tMs: number, startMs: number, endMs: number): HookTitlePhase {
  const total = Math.max(1, endMs - startMs);
  const enterMs = Math.min(ENTER_MS, total * 0.3);
  const exitMs = Math.min(EXIT_MS, total * 0.25);
  const enter = clamp01((tMs - startMs) / enterMs);
  const exit = clamp01((tMs - (endMs - exitMs)) / exitMs);
  return {
    opacity: clamp01(enter * 1.6) * (1 - exit),
    scale: lerp(0.9, 1, easeOutBack(enter)),
    dyEm: lerp(-0.4, 0, easeOutCubic(enter)) - 0.2 * easeInCubic(exit),
  };
}

function glyphRunOf(run: PlacedRun): GlyphRun {
  const glyphs: number[] = [];
  const positions: number[] = [];
  const clusters: number[] = [];
  for (const glyph of run.glyphs) {
    glyphs.push(glyph.id);
    positions.push(glyph.x, glyph.y);
    clusters.push(glyph.cluster);
  }
  return {
    fontId: run.fontId,
    fontSizePx: run.fontSizePx,
    glyphs,
    positions,
    clusters,
    text: run.text,
  };
}

/** One hook title at one instant of its entry or exit. */
export function drawHookTitle(title: HookTitleLayout, phase: HookTitlePhase): DrawCommand[] {
  if (phase.opacity <= 0) return [];
  const fontPx = title.layout.fontSizePx;
  const radius = RADIUS_EM * fontPx;
  const card = roundRect(title.card, radius, radius, { fill: fill(title.cardColour) });
  const children: DrawCommand[] = [
    shadow({ dx: 0, dy: fontPx * 0.08, sigma: fontPx * 0.16, color: "#00000059" }, [card]),
  ];
  for (const line of title.layout.lines) {
    for (const run of line.runs) {
      children.push(text(glyphRunOf(run), { fill: fill(title.inkColour) }));
    }
  }
  const cx = (title.card[0] + title.card[2]) / 2;
  const cy = (title.card[1] + title.card[3]) / 2;
  return [
    transform(scaleTranslateMatrix(phase.scale, cx, cy, 0, phase.dyEm * fontPx), [
      group(children, `hook-title:${title.overlayId}`, phase.opacity),
    ]),
  ];
}

/**
 * Hook titles laid out and placed once, not thirty times a second. Keyed by the
 * projection (or whatever object stands for "this document at this revision"),
 * so an edit — a new projection object — lays everything out afresh, and a
 * render's one projection is laid out once for the whole video.
 */
export class HookTitleCache {
  readonly #byOwner = new WeakMap<object, Map<string, HookTitleLayout | null>>();

  get(
    owner: object,
    key: string,
    compute: () => HookTitleLayout | undefined,
  ): HookTitleLayout | undefined {
    let entries = this.#byOwner.get(owner);
    if (entries === undefined) {
      entries = new Map();
      this.#byOwner.set(owner, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const title = compute();
    entries.set(key, title ?? null);
    return title;
  }
}

export interface RenderHookTitlesOptions {
  readonly overlays: readonly OverlayTrack[];
  /** The instant on the source clock (the same one the captions are drawn at). */
  readonly sourceMs: number;
  /** The document's own style; `undefined` (not in the catalogue) draws nothing. */
  readonly style: StyleDoc | undefined;
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  readonly faces?: CanvasFaceTrack;
  /** What the captions cover during `[startMs, endMs)`, asked once per overlay. */
  readonly captionsDuring: (startMs: number, endMs: number) => readonly Rect[];
  readonly cache: HookTitleCache;
  /** The object {@link HookTitleCache} keys this document by. */
  readonly cacheOwner: object;
}

/**
 * Every hook title on screen at `sourceMs`, drawn in start order. A title that
 * cannot be laid out (no face covers its words) is left out rather than taking
 * the frame — and the captions under it — down with it.
 */
export function renderHookTitles(options: RenderHookTitlesOptions): DrawCommand[] {
  const style = options.style;
  if (style === undefined) return [];
  const commands: DrawCommand[] = [];
  for (const overlay of options.overlays) {
    if (overlay.kind !== HOOK_TITLE_KIND) continue;
    if (options.sourceMs < overlay.startMs || options.sourceMs >= overlay.endMs) continue;
    const key = [
      overlay.id,
      overlay.text,
      overlay.startMs,
      overlay.endMs,
      options.canvas.width,
      options.canvas.height,
      style.id,
      options.faces === undefined ? "-" : String(options.faces.times.length),
    ].join("|");
    const title = options.cache.get(options.cacheOwner, key, () => {
      try {
        return layoutHookTitle({
          overlay,
          style,
          canvas: options.canvas,
          registry: options.registry,
          shaper: options.shaper,
          ...(options.faces === undefined ? {} : { faces: options.faces }),
          captions: options.captionsDuring(overlay.startMs, overlay.endMs),
        });
      } catch (error) {
        if (isRenderError(error)) return undefined;
        throw error;
      }
    });
    if (title === undefined) continue;
    commands.push(
      ...drawHookTitle(title, hookTitlePhase(options.sourceMs, overlay.startMs, overlay.endMs)),
    );
  }
  return commands;
}
