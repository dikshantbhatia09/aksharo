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

import { type EmphasisPreset, type StyleDoc } from "@montaj/caption-styles";

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
import { blurRadiusToSigma, clamp01, ofFontSize, q } from "../units.js";
import { easeOutBack, easeOutBounce, easeOutCubic, lerp, progress, shakeOffset } from "./easing.js";

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
  readonly sigma: number;
  /** Fraction of the caption a typewriter has revealed; 1 means "all of it". */
  readonly reveal: number;
}

const FULL: Phase = { opacity: 1, scale: 1, dy: 0, sigma: 0, reveal: 1 };

/**
 * One end of the cue animation as a set of transforms. `presence` is 1 when the
 * caption is fully on screen and 0 when it is fully absent, so the same
 * function describes the entry (presence rising) and the exit (presence
 * falling).
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
    case "slide-up":
      return { ...FULL, opacity: p, dy: lerp(lineHeightPx * 0.55, 0, easeOutCubic(p)) };
    case "slide-down":
      return { ...FULL, opacity: p, dy: lerp(-lineHeightPx * 0.55, 0, easeOutCubic(p)) };
    case "bounce":
      return { ...FULL, opacity: clamp01(p * 3), scale: lerp(0.6, 1, easeOutBounce(p)) };
    case "blur":
      return { ...FULL, opacity: p, sigma: lerp(lineHeightPx * 0.18, 0, easeOutCubic(p)) };
    case "typewriter":
      return { ...FULL, reveal: p };
    default:
      return FULL;
  }
}

function combine(a: Phase, b: Phase): Phase {
  return {
    opacity: a.opacity * b.opacity,
    scale: a.scale * b.scale,
    dy: a.dy + b.dy,
    sigma: a.sigma + b.sigma,
    reveal: Math.min(a.reveal, b.reveal),
  };
}

/** Where the caption is in its own life at `tMs`. */
export function cueTiming(layout: Layout, style: StyleDoc, tMs: number): Phase {
  const perWord = style.animation.perWord;
  const first = layout.words[0];
  const startMs = perWord && first !== undefined ? first.startMs : layout.startMs;
  const endMs = perWord && first !== undefined ? first.endMs : layout.endMs;

  const enter = cuePhase(
    style.animation.in.type,
    progress(tMs, startMs, style.animation.in.durationMs),
    layout.lineHeightPx,
  );
  const outDuration = style.animation.out.durationMs;
  const leaving =
    outDuration > 0 ? clamp01((tMs - (endMs - outDuration)) / outDuration) : tMs >= endMs ? 1 : 0;
  const exit = cuePhase(style.animation.out.type, 1 - leaving, layout.lineHeightPx);
  return combine(enter, exit);
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

/** Resting colour of one word, before any highlight ground is drawn. */
export function wordColour(
  word: LayoutWord,
  style: StyleDoc,
  tMs: number,
  speakerColours?: Readonly<Record<string, string>>,
): string {
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

function textPaint(style: StyleDoc, layout: Layout, colour: string): Paint {
  const gradient = gradientOf(style.id);
  if (gradient?.target === "text") {
    const radians = (gradient.angleDeg * Math.PI) / 180;
    const width = rectWidth(layout.box);
    const height = rectHeight(layout.box);
    const dx = (Math.cos(radians) * width) / 2;
    const dy = (Math.sin(radians) * height) / 2;
    const cx = (layout.box[0] + layout.box[2]) / 2;
    const cy = (layout.box[1] + layout.box[3]) / 2;
    return linearGradient([cx - dx, cy - dy], [cx + dx, cy + dy], gradient.stops);
  }
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

function karaokeOverlay(word: LayoutWord, style: StyleDoc, tMs: number): DrawCommand[] {
  const state = wordState(word, tMs);
  if (state !== "speaking") return [];
  const fraction = clamp01((tMs - word.startMs) / Math.max(1, word.endMs - word.startMs));
  if (fraction <= 0) return [];
  const colour = style.colors.activeText ?? style.colors.accent ?? style.colors.text;
  const sweepRight = word.box[0] + rectWidth(word.box) * fraction;
  return [
    clipRect(
      [word.box[0], word.box[1], sweepRight, word.box[3]],
      wordInk(word, makeFill(colour), undefined),
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

/** Ground and extra ink an emphasis preset adds behind or around one word. */
function emphasisGround(preset: EmphasisPreset, word: LayoutWord, layout: Layout): DrawCommand[] {
  const colour = preset.color ?? "#ffd400";
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
  const colour = preset?.color ?? baseColour;

  let stroke = typeStroke(style, layout);
  if (preset?.effect === "outline" && stroke === undefined) {
    stroke = makeStroke(preset.color ?? "#000000", ofFontSize(7, layout.fontSizePx));
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
    stroke = makeStroke(colour, ofFontSize(6 * delta, layout.fontSizePx));
  }

  const ink =
    highlight.type === "karaoke-fill"
      ? [
          ...wordInk(word, makeFill(textPaint(style, layout, colour)), stroke),
          ...karaokeOverlay(word, style, tMs),
        ]
      : wordInk(word, makeFill(textPaint(style, layout, colour)), stroke);

  const underline = style.typography.underline === true ? typeUnderline(word, colour, layout) : [];

  const children = [...ground, ...ink, ...underline];

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

  if (phase.scale !== 1 || phase.dy !== 0) {
    const cx = (layout.box[0] + layout.box[2]) / 2;
    const cy = (layout.box[1] + layout.box[3]) / 2;
    content = [transform(scaleTranslateMatrix(phase.scale, cx, cy, 0, phase.dy), content)];
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
};
