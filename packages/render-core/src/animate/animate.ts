/**
 * `animate(layout, style, tMs) → DrawCommand[]`.
 *
 * A pure function of time: given the same layout, style and millisecond it
 * returns the same commands, byte for byte, on every machine. That is the
 * property the cloud renderer, the browser preview and A18a's parity gate all
 * lean on, so nothing in this module may read a clock, a random source or any
 * state left over from the previous frame.
 *
 * Draw order, back to front, for one caption:
 *
 * 1. the box (block, per line or per word);
 * 2. the highlight ground for the word being spoken (box, underline, glow);
 * 3. the type — stroke, then fill, per word so a word can be scaled or
 *    recoloured on its own;
 * 4. the karaoke overlay, clipped to the swept fraction of the active word;
 * 5. emphasis ink (marker highlight, underline, outline, glow, shake).
 *
 * The whole caption is then wrapped in the cue's own transform and opacity.
 */

// The `/browser` subpath, not the barrel: this module is in the browser
// renderer's graph, and the barrel re-exports the fs-backed style registry.
import {
  type EmphasisPreset,
  type Gradient,
  type GradientStop,
  resolveColour,
  type StyleDoc,
} from "@montaj/caption-styles/browser";

import { contrastingInk, withAlpha } from "../colour.js";
import {
  blur,
  clipRect,
  fill as makeFill,
  group,
  image,
  inflate,
  linearGradient,
  rect as makeRect,
  rectHeight,
  rectWidth,
  roundRect,
  scaleTranslateMatrix,
  shadow as makeShadow,
  solid,
  stroke as makeStroke,
  text as makeText,
  transform,
} from "../commands/build.js";
import {
  type DrawCommand,
  type Fill,
  type GlyphRun,
  type Paint,
  type Rect,
  type Stroke,
} from "../commands/types.js";
import { type Layout, type LayoutLine, type LayoutWord, type PlacedRun } from "../layout/types.js";
import { capabilitiesOf, gradientOf } from "../styles/capabilities.js";
import { blurRadiusToSigma, clamp, clamp01, ofFontSize, q } from "../units.js";
import {
  easeOutBack,
  easeOutBounce,
  easeOutCubic,
  easeOutQuad,
  lerp,
  progress,
  shakeOffset,
} from "./easing.js";

export interface AnimateOptions {
  readonly layout: Layout;
  readonly style: StyleDoc;
  readonly tMs: number;
  /** Per-speaker text colours; podcast styles colour a line by who is talking. */
  readonly speakerColours?: Readonly<Record<string, string>>;
  /** Asset id of a watermark image; `renderFrame` passes it through. */
  readonly watermarkAssetId?: string;
  /**
   * K07: overall opacity of the whole caption overlay (type, box, stroke,
   * shadow, depth3d — everything this segment draws), `0`-`1`, multiplied
   * into the cue's own entry/exit fade (`phase.opacity`) rather than
   * replacing it, so a caption still fades in/out under a partial overlay
   * opacity exactly as it does at full opacity. `undefined` (every caller
   * before this field existed) behaves as `1` — fully opaque, byte-for-byte
   * identical to the pre-K07 command tree. Distinct from an individual
   * colour's own `#RRGGBBAA` alpha (`ColorSchema`): this is a single
   * export-time multiplier over the *composited* layer, not a per-colour
   * value baked into the style document.
   */
  readonly captionOpacity?: number;
}

/** Turns a placed run into the flat arrays a backend hands straight to Skia. */
export function toGlyphRun(run: PlacedRun): GlyphRun {
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

interface Phase {
  readonly opacity: number;
  readonly scale: number;
  readonly dy: number;
  /** Horizontal counterpart of `dy` (K05: slide-left/slide-right). */
  readonly dx: number;
  readonly sigma: number;
  /** Fraction of the caption a typewriter has revealed; 1 means "all of it". */
  readonly reveal: number;
}

const FULL: Phase = { opacity: 1, scale: 1, dy: 0, dx: 0, sigma: 0, reveal: 1 };

/**
 * One end of the cue animation as a set of transforms. `presence` is 1 when the
 * caption is fully on screen and 0 when it is fully absent, so the same
 * function describes the entry (presence rising) and the exit (presence
 * falling).
 *
 * K05 added `zoom`/`scale`/`slide-left`/`slide-right`/`rise`/`hide`, matching
 * Kalakar's nine named transitions; none of them are specified byte-for-byte
 * by the reference (only by name and category), so each is a documented,
 * deliberate interpretation:
 *
 * - `zoom` scales in from nothing (0 → 1) with a clean `easeOutCubic` — no
 *   overshoot — reading as a bigger, snappier entrance than `pop`.
 * - `scale` is a smaller pop than `pop` itself: the same `easeOutBack`
 *   overshoot curve, started from 0.85 instead of `pop`'s 0.72, so the
 *   overshoot bump is visibly subtler.
 * - `slide-left`/`slide-right` are the horizontal counterparts of
 *   `slide-up`/`slide-down`: the same travel distance and `easeOutCubic`
 *   easing, on `dx` instead of `dy` — `slide-left` enters from the right and
 *   settles moving left (mirroring `slide-up`'s "starts positive, eases to
 *   0" convention), `slide-right` the reverse.
 * - `rise` is a gentle upward drift: the same direction as `slide-up`, a
 *   little over a third of its travel distance, eased with the softer
 *   `easeOutQuad` instead of `easeOutCubic`.
 * - `hide` is an instant/near-instant cut: opaque the moment any progress
 *   begins, invisible before it, with no fade or easing in between —
 *   `durationMs` still nominally applies (a `SetStyle` write can still set
 *   it) but the presence step ignores its ramp, "clamping" it to zero-effect
 *   rather than reinterpreting the field.
 */
export function cuePhase(
  type: StyleDoc["animation"]["in"]["type"],
  presence: number,
  lineHeightPx: number,
): Phase {
  const p = clamp01(presence);
  switch (type) {
    case "fade":
      return { ...FULL, opacity: p };
    case "pop":
      return { ...FULL, opacity: clamp01(p * 2), scale: lerp(0.72, 1, easeOutBack(p)) };
    case "zoom":
      return { ...FULL, opacity: p, scale: lerp(0, 1, easeOutCubic(p)) };
    case "scale":
      return { ...FULL, opacity: p, scale: lerp(0.85, 1, easeOutBack(p)) };
    case "slide-up":
      return { ...FULL, opacity: p, dy: lerp(lineHeightPx * 0.55, 0, easeOutCubic(p)) };
    case "slide-down":
      return { ...FULL, opacity: p, dy: lerp(-lineHeightPx * 0.55, 0, easeOutCubic(p)) };
    case "slide-left":
      return { ...FULL, opacity: p, dx: lerp(lineHeightPx * 0.55, 0, easeOutCubic(p)) };
    case "slide-right":
      return { ...FULL, opacity: p, dx: lerp(-lineHeightPx * 0.55, 0, easeOutCubic(p)) };
    case "rise":
      return { ...FULL, opacity: p, dy: lerp(lineHeightPx * 0.2, 0, easeOutQuad(p)) };
    case "bounce":
      return { ...FULL, opacity: clamp01(p * 3), scale: lerp(0.6, 1, easeOutBounce(p)) };
    case "blur":
      return { ...FULL, opacity: p, sigma: lerp(lineHeightPx * 0.18, 0, easeOutCubic(p)) };
    case "typewriter":
      return { ...FULL, reveal: p };
    case "hide":
      return { ...FULL, opacity: p > 0 ? 1 : 0 };
    case "kinetic-flow":
      return { ...FULL, opacity: clamp01(p * 2), scale: lerp(0.72, 1, easeOutBack(p)) };
    default:
      return FULL;
  }
}

function combine(a: Phase, b: Phase): Phase {
  return {
    opacity: a.opacity * b.opacity,
    scale: a.scale * b.scale,
    dy: a.dy + b.dy,
    dx: a.dx + b.dx,
    sigma: a.sigma + b.sigma,
    reveal: Math.min(a.reveal, b.reveal),
  };
}

/**
 * K05: Speed Mode "Dynamic" — the effective in/out duration when
 * `animation.dynamicSpeed` is on, derived from the caption's own on-screen
 * span (`spanMs`) instead of the fixed `durationMs` the style declares.
 * Kalakar's copy for this ("Automatically calculated based on timing") names
 * no formula, so this is a documented interpretation: a fifth of the span,
 * clamped so a flashed-by caption still gets a perceptible transition and a
 * long-held one does not crawl.
 */
const DYNAMIC_SPEED_FRACTION = 0.2;
const DYNAMIC_SPEED_MIN_MS = 120;
const DYNAMIC_SPEED_MAX_MS = 600;

function dynamicCueDurationMs(spanMs: number): number {
  return clamp(spanMs * DYNAMIC_SPEED_FRACTION, DYNAMIC_SPEED_MIN_MS, DYNAMIC_SPEED_MAX_MS);
}

function cueDurationMs(configuredMs: number, spanMs: number, dynamic: boolean): number {
  return dynamic ? dynamicCueDurationMs(spanMs) : configuredMs;
}

/**
 * Multi-directional kinetic choreography cycle.
 * Alternates spatial camera motion (going left, going right, 90° turns, zoom, flat slam)
 * across consecutive subtitle segments with a single click.
 */
const KINETIC_FLOW_CYCLE: readonly {
  readonly in: StyleDoc["animation"]["in"]["type"];
  readonly out: StyleDoc["animation"]["out"]["type"];
}[] = [
  { in: "pop", out: "slide-left" },       // Cue 0: Scale punch -> camera pans right (cue exits left)
  { in: "slide-left", out: "slide-up" },   // Cue 1: Enters from right -> camera shifts down (cue exits up)
  { in: "slide-up", out: "slide-right" },  // Cue 2: Enters from bottom -> camera pans left (cue exits right)
  { in: "slide-right", out: "zoom" },      // Cue 3: Enters from left -> zoom dissolve
  { in: "zoom", out: "slide-down" },       // Cue 4: Expanding center disc -> camera moves up
  { in: "bounce", out: "slide-left" },     // Cue 5: Top impact slam -> camera pans right
  { in: "slide-left", out: "pop" },        // Cue 6: Horizontal tracking sweep -> cyan pop
  { in: "bounce", out: "fade" },           // Cue 7: Flat slab punch slam (0° tilt) -> fade
];

function parseSeq(seq: string | number | undefined): number | undefined {
  if (typeof seq === "number") return Math.abs(Math.floor(seq));
  if (typeof seq === "string") {
    const num = parseInt(seq, 10);
    if (!isNaN(num)) return Math.abs(num);
    let hash = 0;
    for (let i = 0; i < seq.length; i++) {
      hash = (hash * 31 + seq.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
  return undefined;
}

function resolveCueAnimationTypes(
  style: StyleDoc,
  layout?: Layout,
): {
  readonly inType: StyleDoc["animation"]["in"]["type"];
  readonly outType: StyleDoc["animation"]["out"]["type"];
} {
  if (style.animation.in.type !== "kinetic-flow" && style.animation.out.type !== "kinetic-flow") {
    return { inType: style.animation.in.type, outType: style.animation.out.type };
  }
  const parsed = parseSeq(layout?.segmentSeq);
  const idx =
    parsed !== undefined
      ? parsed
      : layout?.startMs !== undefined
        ? Math.floor(layout.startMs / 2000)
        : 0;
  const cycle = KINETIC_FLOW_CYCLE[idx % KINETIC_FLOW_CYCLE.length] ?? KINETIC_FLOW_CYCLE[0]!;
  return {
    inType: style.animation.in.type === "kinetic-flow" ? cycle.in : style.animation.in.type,
    outType: style.animation.out.type === "kinetic-flow" ? cycle.out : style.animation.out.type,
  };
}

/**
 * The cue phase for one on-screen window `[startMs, endMs)` — the whole
 * caption's own span for the default "line" cue scope, or one word's own
 * span for K05's "word" cue scope (`animateWordScope`). Factored out of
 * `cueTiming` so both scopes, and Speed Mode Dynamic's duration override,
 * share one implementation.
 */
function cuePhaseWindow(
  startMs: number,
  endMs: number,
  style: StyleDoc,
  tMs: number,
  lineHeightPx: number,
  layout?: Layout,
): Phase {
  const dynamic = style.animation.dynamicSpeed === true;
  const spanMs = Math.max(0, endMs - startMs);
  const inDuration = cueDurationMs(style.animation.in.durationMs, spanMs, dynamic);
  const outDuration = cueDurationMs(style.animation.out.durationMs, spanMs, dynamic);

  const { inType, outType } = resolveCueAnimationTypes(style, layout);

  const enter = cuePhase(inType, progress(tMs, startMs, inDuration), lineHeightPx);
  const leaving =
    outDuration > 0 ? clamp01((tMs - (endMs - outDuration)) / outDuration) : tMs >= endMs ? 1 : 0;
  const exit = cuePhase(outType, 1 - leaving, lineHeightPx);
  return combine(enter, exit);
}

/** Where the caption is in its own life at `tMs`. */
export function cueTiming(layout: Layout, style: StyleDoc, tMs: number): Phase {
  const perWord = style.animation.perWord;
  const first = layout.words[0];
  const startMs = perWord && first !== undefined ? first.startMs : layout.startMs;
  const endMs = perWord && first !== undefined ? first.endMs : layout.endMs;
  return cuePhaseWindow(startMs, endMs, style, tMs, layout.lineHeightPx, layout);
}

/**
 * K05: one word's own cue phase, for `animation.cueScope === "word"`.
 *
 * The window is `[word.startMs, layout.endMs]`, **not** `[word.startMs,
 * word.endMs]` — a word's own `startMs`/`endMs` is how long it is the *word
 * being spoken* (what drives `wordHighlight`), which for a normal multi-word
 * caption is a short slice near the front of the caption's life. Using that
 * slice as the cue window would make each word's `out` cue finish, and the
 * word vanish, the moment it stops being the active word — so a caption
 * would visibly shed its earlier words as playback moved on, which is not
 * what "Applied on Word" means in the reference product or in any caption
 * tool. The word enters on its own schedule (`word.startMs`, so words
 * cascade in one after another as the caption first appears) and then holds
 * — same as line scope — until the caption's own `endMs`, where every word
 * still on screen leaves together. Only the entrance staggers; the exit is
 * shared. Documented interpretation: the addendum's evidence names the
 * toggle but not this detail.
 */
function wordCuePhase(word: LayoutWord, layout: Layout, style: StyleDoc, tMs: number): Phase {
  return cuePhaseWindow(word.startMs, layout.endMs, style, tMs, layout.lineHeightPx, layout);
}

/** `sung | speaking | upcoming` for one word at `tMs`. */
export type WordState = "sung" | "speaking" | "upcoming";

export function wordState(word: LayoutWord, tMs: number): WordState {
  if (tMs < word.startMs) return "upcoming";
  if (tMs < word.endMs) return "speaking";
  return "sung";
}

function highlightProgress(word: LayoutWord, tMs: number, durationMs: number): number {
  if (durationMs <= 0)
    return clamp01((tMs - word.startMs) / Math.max(1, word.endMs - word.startMs));
  return progress(tMs, word.startMs, durationMs);
}

/**
 * Resting colour of one word, before any highlight ground is drawn. A plain
 * string, or (K08) the `Gradient` `style.colors.text` itself carries — this
 * function only *resolves which colour source wins* (speaker, karaoke state,
 * word-highlight, upcoming-text); it is `textPaint` below, called with the
 * word's own box, that turns a `Gradient` result into an absolute `Paint`.
 */
export function wordColour(
  word: LayoutWord,
  style: StyleDoc,
  tMs: number,
  speakerColours?: Readonly<Record<string, string>>,
): string | Gradient {
  const speaker = word.sp === undefined ? undefined : speakerColours?.[word.sp];
  const base = speaker ?? style.colors.text;
  const state = wordState(word, tMs);
  const highlight = style.animation.wordHighlight.type;

  if (highlight === "karaoke-fill") {
    if (state === "sung") return style.colors.activeText ?? base;
    return style.colors.upcomingText ?? base;
  }
  if (
    state === "speaking" &&
    (highlight === "color" || highlight === "scale" || highlight === "glow")
  ) {
    return style.colors.activeText ?? style.colors.accent ?? base;
  }
  if (state === "upcoming" && style.colors.upcomingText !== undefined)
    return style.colors.upcomingText;
  return base;
}

function boxRadius(box: Rect, radiusPct: number): number {
  return (radiusPct / 100) * rectHeight(box);
}

/**
 * A linear-gradient `Paint` from a stop ramp and the box it fills — shared by
 * the schema-driven per-word/per-run gradient (K08's `Gradient`, `box` is the
 * word's own bounding box) and the legacy per-style gradient lookup
 * (`gradientOf`, `box` is the whole caption's `layout.box`) in `textPaint`
 * below, so both compute the same from/to geometry from an angle and neither
 * duplicates the trig. `angleDeg` follows the CSS gradient-angle convention
 * (documented on `GradientSchema`): 0 is left-to-right, 90 is top-to-bottom,
 * measured clockwise — at 0° `dx = width/2, dy = 0` runs the ramp along the
 * box's own horizontal axis; at 90° `dx = 0, dy = height/2` runs it along the
 * vertical one.
 */
function gradientPaint(
  box: Rect,
  gradient: { readonly angleDeg: number; readonly stops: readonly GradientStop[] },
): Paint {
  const radians = (gradient.angleDeg * Math.PI) / 180;
  const width = rectWidth(box);
  const height = rectHeight(box);
  const dx = (Math.cos(radians) * width) / 2;
  const dy = (Math.sin(radians) * height) / 2;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  return linearGradient([cx - dx, cy - dy], [cx + dx, cy + dy], gradient.stops);
}

/**
 * The `Paint` for one word's glyph ink. `wordBox` is always the word's own
 * bounding box (`word.box`), never the whole caption's — K08 ships gradient
 * scope per-word (the reference evidence's Word/Character "Level" dropdown
 * is a documented follow-up, see REPORT.md), so a multi-word caption repeats
 * the same ramp across each word rather than stretching one ramp across the
 * whole line.
 *
 * Two independent gradient sources can apply, checked in order: `colour`
 * itself is a `Gradient` (K08, schema-driven — a style or an override set
 * `colors.text`/an emphasis preset's `color` to one), or the style's `id` is
 * one of the four `capabilitiesOf`/`gradientOf` entries (`styles/
 * capabilities.ts` — the pre-existing, per-style-id side channel `prism-split`
 * and `gradient-sweep` use, unrelated to and unchanged by this WP: it still
 * paints across the whole `layout.box`, exactly as before). No shipped style
 * uses both, so there is no real precedence question today — the schema
 * branch is checked first only because it is the cheaper, more specific test.
 */
function textPaint(
  style: StyleDoc,
  layout: Layout,
  wordBox: Rect,
  colour: string | Gradient,
): Paint {
  if (typeof colour !== "string") return gradientPaint(wordBox, colour);
  const gradient = gradientOf(style.id);
  if (gradient?.target === "text") return gradientPaint(layout.box, gradient);
  return solid(colour);
}

/**
 * The paint for a box, wherever it is drawn — block, line or word. Styles whose
 * capability table names a `box` gradient get it here, so a line-mode style and
 * a block-mode style are painted the same way.
 */
function boxFill(style: StyleDoc, box: Rect): Fill {
  const gradient = gradientOf(style.id);
  if (gradient?.target === "box") {
    const radians = (gradient.angleDeg * Math.PI) / 180;
    const dx = (Math.cos(radians) * (box[2] - box[0])) / 2;
    const dy = (Math.sin(radians) * (box[3] - box[1])) / 2;
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    return makeFill(
      linearGradient([cx - dx, cy - dy], [cx + dx, cy + dy], gradient.stops),
      style.box.opacity,
    );
  }
  return makeFill(style.box.fill ?? "#000000", style.box.opacity);
}

function typeStroke(style: StyleDoc, layout: Layout): Stroke | undefined {
  if (!style.stroke.enabled || style.stroke.widthPct <= 0) return undefined;
  return makeStroke(
    style.stroke.color ?? "#000000",
    ofFontSize(style.stroke.widthPct, layout.fontSizePx),
  );
}

/** Ink for one word: stroke under fill, one command per placed run. */
function wordInk(word: LayoutWord, fill: Fill, stroke: Stroke | undefined): DrawCommand[] {
  const commands: DrawCommand[] = [];
  for (const run of word.runs) {
    const glyphRun = toGlyphRun(run);
    if (stroke !== undefined) commands.push(makeText(glyphRun, { stroke }));
    commands.push(makeText(glyphRun, { fill }));
  }
  return commands;
}

function karaokeOverlay(
  word: LayoutWord,
  style: StyleDoc,
  layout: Layout,
  tMs: number,
): DrawCommand[] {
  const state = wordState(word, tMs);
  if (state !== "speaking") return [];
  const fraction = clamp01((tMs - word.startMs) / Math.max(1, word.endMs - word.startMs));
  if (fraction <= 0) return [];
  const colour = style.colors.activeText ?? style.colors.accent ?? style.colors.text;
  const sweepRight = word.box[0] + rectWidth(word.box) * fraction;
  return [
    clipRect(
      [word.box[0], word.box[1], sweepRight, word.box[3]],
      wordInk(word, makeFill(textPaint(style, layout, word.box, colour)), undefined),
    ),
  ];
}

/**
 * `typography.underline`'s rule under one word (K01) — a static, always-on
 * underline for the caption's own type, distinct from the word-highlight
 * `underline` type (one word, only while it is being spoken) and from an
 * emphasis preset's `underline` effect (one marked word). Coloured like the
 * word's own ink so a multi-colour caption (speaker colours, karaoke fill)
 * keeps a matching rule under each word rather than one flat colour.
 */
function typeUnderline(word: LayoutWord, colour: string, layout: Layout): DrawCommand[] {
  const thickness = ofFontSize(6, layout.fontSizePx);
  const top = word.box[3] + thickness * 0.4;
  return [makeRect([word.box[0], top, word.box[2], top + thickness], { fill: makeFill(colour) })];
}

/**
 * `typography.strikethrough`'s rule under one word (K05) — the Format row's
 * fourth button (B/I/U/S). Mirrors `typeUnderline` exactly, except the rule
 * sits through the middle of the word's own em box (halfway between its
 * ascent-line top and its descent-line bottom) instead of underneath it, so
 * it reads as a strike through the glyphs rather than a rule under them.
 */
function typeStrikethrough(word: LayoutWord, colour: string, layout: Layout): DrawCommand[] {
  const thickness = ofFontSize(6, layout.fontSizePx);
  const middle = (word.box[1] + word.box[3]) / 2;
  return [
    makeRect([word.box[0], middle - thickness / 2, word.box[2], middle + thickness / 2], {
      fill: makeFill(colour),
    }),
  ];
}

/** The ground drawn behind the word being spoken, per `animation.wordHighlight`. */
function highlightGround(
  word: LayoutWord,
  style: StyleDoc,
  layout: Layout,
  tMs: number,
): DrawCommand[] {
  if (wordState(word, tMs) !== "speaking") return [];
  const { type, durationMs } = style.animation.wordHighlight;
  const eased = easeOutCubic(highlightProgress(word, tMs, durationMs));
  const accent = style.colors.accent ?? style.colors.activeText ?? "#ffffff";
  const padding = ofFontSize(12, layout.fontSizePx);

  switch (type) {
    case "box": {
      const box = inflate(word.box, padding * 0.5);
      return [
        roundRect(box, boxRadius(box, 26), boxRadius(box, 26), { fill: makeFill(accent, eased) }),
      ];
    }
    case "underline": {
      const thickness = ofFontSize(8, layout.fontSizePx);
      const top = word.box[3] + thickness * 0.4;
      const right = lerp(word.box[0], word.box[2], eased);
      return [makeRect([word.box[0], top, right, top + thickness], { fill: makeFill(accent) })];
    }
    case "glow": {
      const sigma = blurRadiusToSigma(ofFontSize(28, layout.fontSizePx)) * eased;
      return sigma <= 0
        ? []
        : [
            makeShadow(
              { dx: 0, dy: 0, sigma, color: accent, shadowOnly: true },
              wordInk(word, makeFill(accent), undefined),
            ),
          ];
    }
    default:
      return [];
  }
}

function emphasisOf(style: StyleDoc, word: LayoutWord): EmphasisPreset | undefined {
  if (word.emphasisPresetId === undefined) return undefined;
  return style.emphasisPresets.find((preset) => preset.id === word.emphasisPresetId);
}

/**
 * Ground and extra ink an emphasis preset adds behind or around one word.
 * Solid-only by design (a highlight box, an underline rule, a glow shadow
 * cast from the word's own silhouette): out of K08's scope, which is the
 * word's own glyph fill, not its decorative ground. A `Gradient` preset
 * colour resolves to `resolveColour`'s first-stop stand-in here — the same
 * approximation a stroke or a shadow colour would need.
 */
function emphasisGround(preset: EmphasisPreset, word: LayoutWord, layout: Layout): DrawCommand[] {
  const colour = preset.color === undefined ? "#ffd400" : resolveColour(preset.color);
  switch (preset.effect) {
    case "highlight": {
      const box = inflate(word.box, ofFontSize(8, layout.fontSizePx));
      return [
        roundRect(box, boxRadius(box, 18), boxRadius(box, 18), { fill: makeFill(colour, 0.9) }),
      ];
    }
    case "underline": {
      const thickness = ofFontSize(9, layout.fontSizePx);
      const top = word.box[3] + thickness * 0.3;
      return [
        makeRect([word.box[0], top, word.box[2], top + thickness], { fill: makeFill(colour) }),
      ];
    }
    case "glow":
      return [
        makeShadow(
          {
            dx: 0,
            dy: 0,
            sigma: blurRadiusToSigma(ofFontSize(24, layout.fontSizePx)),
            color: colour,
            shadowOnly: true,
          },
          wordInk(word, makeFill(colour), undefined),
        ),
      ];
    default:
      // `shake`, `none` and an outline are drawn with the type, not behind it.
      return [];
  }
}

/** Everything drawn for one word: ground, type, karaoke overlay, transforms. */
function wordCommands(
  word: LayoutWord,
  style: StyleDoc,
  layout: Layout,
  tMs: number,
  options: AnimateOptions,
): DrawCommand[] {
  const preset = emphasisOf(style, word);
  const state = wordState(word, tMs);
  const highlight = style.animation.wordHighlight;

  const ground: DrawCommand[] = [
    ...(style.box.enabled && style.box.mode === "word"
      ? [
          (() => {
            const box = inflate(
              word.box,
              ofFontSize(style.box.paddingPct, layout.fontSizePx) * 0.5,
            );
            return roundRect(
              box,
              boxRadius(box, style.box.radiusPct),
              boxRadius(box, style.box.radiusPct),
              {
                fill: boxFill(style, box),
              },
            );
          })(),
        ]
      : []),
    ...highlightGround(word, style, layout, tMs),
    ...(preset === undefined ? [] : emphasisGround(preset, word, layout)),
  ];

  const highlighted = state === "speaking" && highlight.type === "box";
  const baseColour = highlighted
    ? contrastingInk(style.colors.accent ?? style.colors.activeText ?? "#ffffff")
    : wordColour(word, style, tMs, options.speakerColours);
  // The word's own glyph-fill colour (K08: `string | Gradient`) — the only
  // place in this function a `Gradient` is actually painted as one, via
  // `textPaint(..., word.box, colour)` below. Every other use of `colour` in
  // this function (stroke, underline, strikethrough) is solid-only ground, so
  // it goes through `resolveColour` first.
  const colour = preset?.color ?? baseColour;
  const solidColour = resolveColour(colour);

  let stroke = typeStroke(style, layout);
  if (preset?.effect === "outline" && stroke === undefined) {
    stroke = makeStroke(
      preset.color === undefined ? "#000000" : resolveColour(preset.color),
      ofFontSize(7, layout.fontSizePx),
    );
  }
  // A heavier emphasis weight cannot re-shape the run (the face was resolved at
  // layout time), so it is drawn as a faux bold: a hairline stroke in the fill
  // colour. Documented in the README as a deliberate approximation.
  if (
    preset?.weight !== undefined &&
    preset.weight > style.typography.weight &&
    stroke === undefined
  ) {
    const delta = (preset.weight - style.typography.weight) / 900;
    stroke = makeStroke(solidColour, ofFontSize(6 * delta, layout.fontSizePx));
  }

  const ink =
    highlight.type === "karaoke-fill"
      ? [
          ...wordInk(word, makeFill(textPaint(style, layout, word.box, colour)), stroke),
          ...karaokeOverlay(word, style, layout, tMs),
        ]
      : wordInk(word, makeFill(textPaint(style, layout, word.box, colour)), stroke);

  // K05: an emphasis preset's own `underline` overrides the base caption's
  // `typography.underline` for this word only; absent, it falls back to the
  // base caption's own setting, so a preset with no typography override
  // renders byte-identical to before this WP.
  const underlineOn = preset?.underline ?? style.typography.underline === true;
  const underline = underlineOn ? typeUnderline(word, solidColour, layout) : [];
  const strikethrough =
    style.typography.strikethrough === true ? typeStrikethrough(word, solidColour, layout) : [];

  const children = [...ground, ...ink, ...underline, ...strikethrough];

  // Per-word scale: the highlight's own growth multiplied by the emphasis scale.
  const highlightScale =
    state === "speaking" && highlight.type === "scale"
      ? lerp(
          1,
          highlight.scale ?? 1.15,
          easeOutBack(highlightProgress(word, tMs, highlight.durationMs)),
        )
      : 1;
  const scale = highlightScale * (preset?.scale ?? 1);
  const shake =
    preset?.effect === "shake"
      ? shakeOffset(tMs, ofFontSize(3, layout.fontSizePx), word.index)
      : { x: 0, y: 0 };

  if (scale === 1 && shake.x === 0 && shake.y === 0) return children;
  const cx = (word.box[0] + word.box[2]) / 2;
  const cy = (word.box[1] + word.box[3]) / 2;
  return [transform(scaleTranslateMatrix(scale, cx, cy, shake.x, shake.y), children)];
}

function lineCommands(
  line: LayoutLine,
  style: StyleDoc,
  layout: Layout,
  tMs: number,
  options: AnimateOptions,
): DrawCommand[] {
  const children: DrawCommand[] = [];
  if (style.box.enabled && style.box.mode === "line") {
    const box = inflate(line.box, ofFontSize(style.box.paddingPct, layout.fontSizePx));
    children.push(
      roundRect(box, boxRadius(box, style.box.radiusPct), boxRadius(box, style.box.radiusPct), {
        fill: boxFill(style, box),
      }),
    );
  }
  for (const word of line.words) children.push(...wordCommands(word, style, layout, tMs, options));
  return children;
}

/** Blocks the whole caption sits on: the `block` box, plus any backdrop blur. */
function blockGround(style: StyleDoc, layout: Layout): DrawCommand[] {
  if (!style.box.enabled || style.box.mode !== "block") return [];
  const box = layout.paddedBox;
  const radius = boxRadius(box, style.box.radiusPct);
  const panel = roundRect(box, radius, radius, { fill: boxFill(style, box) });
  if (!capabilitiesOf(style.id).backdrop) return [panel];
  // Liquid glass: blur what is already on the surface inside the panel, then
  // lay the translucent panel over it.
  const sigma = blurRadiusToSigma(ofFontSize(40, layout.fontSizePx));
  return [blur({ sigmaX: sigma, sigmaY: sigma, backdrop: true, bounds: box }, [panel])];
}

/** The default number of extrusion layers when a style enables `depth3d` but omits `layers`. */
const DEPTH3D_DEFAULT_LAYERS = 6;

/**
 * K01's faux-3D extrusion: a small stack of flat, single-colour copies of
 * every word's glyphs, stepping diagonally away from the reader and drawn
 * behind the real (stroked, highlighted, per-word-coloured) type the rest of
 * `animate` draws on top. Each copy reuses `wordInk` — the same primitive the
 * main ink and the karaoke overlay already draw with — rather than a new text
 * primitive, so a depth layer shapes exactly like the glyphs it sits behind.
 *
 * Layers are capped (schema: 1-8, default 6) because this runs every frame;
 * the farthest layer is drawn first so nearer layers correctly paint over it.
 */
function depth3dCommands(style: StyleDoc, layout: Layout): DrawCommand[] {
  const depth = style.depth3d;
  if (depth === undefined || !depth.enabled || depth.offsetPct <= 0) return [];
  const layers = Math.max(1, Math.min(depth.layers ?? DEPTH3D_DEFAULT_LAYERS, 8));
  const stepPx = ofFontSize(depth.offsetPct, layout.fontSizePx) / layers;
  const fill = makeFill(depth.color);

  const glyphs: DrawCommand[] = [];
  for (const line of layout.lines) {
    for (const word of line.words) glyphs.push(...wordInk(word, fill, undefined));
  }
  if (glyphs.length === 0) return [];

  const commands: DrawCommand[] = [];
  for (let layer = layers; layer >= 1; layer -= 1) {
    const offset = q(stepPx * layer);
    commands.push(
      transform(scaleTranslateMatrix(1, 0, 0, offset, offset), [
        group(glyphs, `depth3d:${String(layer)}`),
      ]),
    );
  }
  return commands;
}

/** Deterministic RGB-split / warble copies for the raster styles. */
function rasterCopies(
  style: StyleDoc,
  layout: Layout,
  tMs: number,
  body: readonly DrawCommand[],
): DrawCommand[] {
  if (!capabilitiesOf(style.id).raster) return [...body];
  const amplitude = ofFontSize(style.id === "tape-retro" ? 2.5 : 5, layout.fontSizePx);
  const offset = shakeOffset(tMs, amplitude, 1);
  const red = transform(
    [1, 0, 0, 1, q(-offset.x), q(-offset.y * 0.3)],
    [group(body, "raster:left", 0.55)],
  );
  const cyan = transform(
    [1, 0, 0, 1, q(offset.x), q(offset.y * 0.3)],
    [group(body, "raster:right", 0.55)],
  );
  return [red, cyan, ...body];
}

export function animate(options: AnimateOptions): DrawCommand[] {
  const { layout, style, tMs } = options;
  // K05: `cueScope: "word"` is a completely separate code path
  // (`animateWordScope`) rather than a branch threaded through this
  // function, specifically so the "line" scope below — every existing
  // style's behaviour, since `cueScope` is additive and absent on all of
  // them — is untouched line for line and the golden hashes cannot move.
  if (style.animation.cueScope === "word") return animateWordScope(options);

  const phase = cueTiming(layout, style, tMs);
  if (phase.opacity <= 0) return [];

  const body: DrawCommand[] = [...blockGround(style, layout), ...depth3dCommands(style, layout)];
  const totalWidth = layout.lines.reduce((sum, line) => sum + rectWidth(line.box), 0);
  let revealedBefore = 0;

  for (const line of layout.lines) {
    const commands = lineCommands(line, style, layout, tMs, options);
    if (phase.reveal >= 1 || totalWidth <= 0) {
      body.push(...commands);
      revealedBefore += rectWidth(line.box);
      continue;
    }
    const revealed = phase.reveal * totalWidth - revealedBefore;
    revealedBefore += rectWidth(line.box);
    if (revealed <= 0) continue;
    const right = Math.min(line.box[2], line.box[0] + revealed);
    body.push(clipRect([line.box[0], line.box[1], right, line.box[3]], commands));
  }

  let content: DrawCommand[] = rasterCopies(style, layout, tMs, body);

  if (style.shadow.enabled && style.shadow.opacity > 0) {
    content = [
      makeShadow(
        {
          dx: ofFontSize(style.shadow.offsetXPct, layout.fontSizePx),
          dy: ofFontSize(style.shadow.offsetYPct, layout.fontSizePx),
          sigma: blurRadiusToSigma(ofFontSize(style.shadow.blurPct, layout.fontSizePx)),
          color: withAlpha(style.shadow.color ?? "#000000", style.shadow.opacity),
        },
        content,
      ),
    ];
  }

  if (phase.sigma > 0) {
    content = [blur({ sigmaX: phase.sigma, sigmaY: phase.sigma }, content)];
  }

  if (phase.scale !== 1 || phase.dy !== 0 || phase.dx !== 0) {
    const cx = (layout.box[0] + layout.box[2]) / 2;
    const cy = (layout.box[1] + layout.box[3]) / 2;
    content = [transform(scaleTranslateMatrix(phase.scale, cx, cy, phase.dx, phase.dy), content)];
  }

  // K07: the export-time caption-opacity slider multiplies into the same
  // group opacity the cue's own fade in/out already sets — `clamp01` both
  // guards against an out-of-range caller value and keeps the product in
  // range even though each factor already is (a defensive habit this file
  // already follows for `phase.opacity` at the top of this function).
  const overlayOpacity = clamp01(options.captionOpacity ?? 1);
  const commands: DrawCommand[] = [
    group(content, `segment:${layout.segmentId}`, clamp01(phase.opacity * overlayOpacity)),
  ];
  if (options.watermarkAssetId !== undefined) {
    commands.push(watermarkCommand(options.watermarkAssetId, layout));
  }
  return commands;
}

/**
 * K05: `animation.cueScope === "word"` — the in/out cue animates each word
 * independently, using that word's own start/end as its window
 * (`wordCuePhase`), instead of the whole caption entering/leaving as one
 * block. Kalakar's Transitions tab calls this "Applied on Word"; the block
 * ground (a `block`-mode box), 3D depth and the style's own drop shadow are
 * still keyed off the caption's own envelope (`cueTiming`) — they are
 * properties of the caption as a whole, not of any one word, so only the
 * per-word ground+ink (`wordCommands`) gets its own phase here.
 */
function animateWordScope(options: AnimateOptions): DrawCommand[] {
  const { layout, style, tMs } = options;
  const envelope = cueTiming(layout, style, tMs);
  if (envelope.opacity <= 0) return [];

  const body: DrawCommand[] = [...blockGround(style, layout), ...depth3dCommands(style, layout)];

  for (const line of layout.lines) {
    if (style.box.enabled && style.box.mode === "line") {
      const box = inflate(line.box, ofFontSize(style.box.paddingPct, layout.fontSizePx));
      body.push(
        roundRect(box, boxRadius(box, style.box.radiusPct), boxRadius(box, style.box.radiusPct), {
          fill: boxFill(style, box),
        }),
      );
    }

    for (const word of line.words) {
      const phase = wordCuePhase(word, layout, style, tMs);
      if (phase.opacity <= 0) continue;

      let wordContent = wordCommands(word, style, layout, tMs, options);

      if (phase.reveal < 1) {
        const revealed = phase.reveal * rectWidth(word.box);
        if (revealed <= 0) continue;
        const right = Math.min(word.box[2], word.box[0] + revealed);
        wordContent = [clipRect([word.box[0], word.box[1], right, word.box[3]], wordContent)];
      }
      if (phase.sigma > 0) {
        wordContent = [blur({ sigmaX: phase.sigma, sigmaY: phase.sigma }, wordContent)];
      }
      if (phase.scale !== 1 || phase.dy !== 0 || phase.dx !== 0) {
        const cx = (word.box[0] + word.box[2]) / 2;
        const cy = (word.box[1] + word.box[3]) / 2;
        wordContent = [
          transform(scaleTranslateMatrix(phase.scale, cx, cy, phase.dx, phase.dy), wordContent),
        ];
      }
      body.push(group(wordContent, undefined, phase.opacity));
    }
  }

  let content: DrawCommand[] = rasterCopies(style, layout, tMs, body);

  if (style.shadow.enabled && style.shadow.opacity > 0) {
    content = [
      makeShadow(
        {
          dx: ofFontSize(style.shadow.offsetXPct, layout.fontSizePx),
          dy: ofFontSize(style.shadow.offsetYPct, layout.fontSizePx),
          sigma: blurRadiusToSigma(ofFontSize(style.shadow.blurPct, layout.fontSizePx)),
          color: withAlpha(style.shadow.color ?? "#000000", style.shadow.opacity),
        },
        content,
      ),
    ];
  }

  const commands: DrawCommand[] = [group(content, `segment:${layout.segmentId}`)];
  if (options.watermarkAssetId !== undefined) {
    commands.push(watermarkCommand(options.watermarkAssetId, layout));
  }
  return commands;
}

/** The watermark: bottom-right, an eighth of the canvas width, inside the safe area. */
export function watermarkCommand(assetId: string, layout: Layout): DrawCommand {
  const width = layout.canvas.width * 0.18;
  const height = width * 0.28;
  const margin = layout.canvas.height * 0.03;
  const right = layout.canvas.width - margin;
  const bottom = layout.canvas.height - margin;
  return image(assetId, [right - width, bottom - height, right, bottom], 0.85);
}

/** Exposed for the animation tests; not part of the public surface. */
export const __testing = {
  cuePhase,
  combine,
  highlightGround,
  wordCommands,
  rasterCopies,
  boxRadius,
  wordCuePhase,
  dynamicCueDurationMs,
  animateWordScope,
  textPaint,
  gradientPaint,
  emphasisGround,
};
