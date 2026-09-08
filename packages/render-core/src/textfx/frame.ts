/**
 * `renderTitleFrame` — one output millisecond's accepted title items (D06's
 * `RenderManifest.timemap.titles`) as `DrawCommand[]`, the one shared step
 * `apps/web/lib/export/engine.ts` (browser) and `apps/render`'s frame loop
 * (cloud) both call so a title draws identically on both backends (D33).
 *
 * A title item carries only `text`/`intent`/`motionPreset` on the wire
 * (`TitleTrackSchema`) — no colour, no font, no packed curve, unlike a
 * caption or a keyframe track. It borrows the render's own default caption
 * style for its ink (a heavier weight of the same family, the style's own
 * text/accent colours) so a title always matches the video's caption look
 * with nothing extra to configure, and it has no curve of its own because
 * `placeTitleBox` derives its rectangle every frame from the caption's own
 * live safe area (D06 rule 2) — there is nothing to interpolate between
 * keyframes.
 */

import { resolveColour, type StyleDoc } from "@montaj/caption-styles";
import { type TimeQuery } from "@montaj/timemap";

import { countUpText } from "./count.js";
import { drawTextFxTitle } from "./draw.js";
import { placeTitleBox, type TitleSize } from "./layout.js";
import { textFxPhase, textFxProgress, type TextFxMotionPreset } from "./presets.js";
import { type DrawCommand, type GlyphRun, type Rect } from "../commands/types.js";
import { resolveFontOrThrow } from "../fonts/registry.js";
import { codePointsOf } from "../fonts/shaper.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type Layout } from "../layout/types.js";
import { detectWordScript, type WordScript } from "../script.js";
import { assertCanvas, type CanvasSize } from "../units.js";

/** The wire shape `renderTitleFrame` needs from a `TitleTrack` (D06). */
export interface TitleFxTrack {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly motionPreset: TextFxMotionPreset;
}

export interface RenderTitlesOptions {
  readonly titles: readonly TitleFxTrack[];
  /** `null` when the project has no edits: output time is source time. */
  readonly timemap: TimeQuery | null;
  readonly outputMs: number;
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** The render's default caption style; a title borrows its ink and family. */
  readonly style: StyleDoc;
  /** The active caption's own safe-area rectangle at this frame, or `undefined` when none is on screen. */
  readonly captionBox?: Rect | undefined;
}

/** Font size for every title: a fixed fraction of canvas height, independent of any caption's own (possibly shrunk) size. */
const TITLE_FONT_SCALE = 0.075;
/** Measured box height over the font's own ascender-descender span, for breathing room around the glyphs. */
const TITLE_BOX_LINE_FACTOR = 1.2;

function titleFontSizePx(canvas: CanvasSize): number {
  return canvas.height * TITLE_FONT_SCALE;
}

interface ShapedTitle {
  readonly run: GlyphRun;
  readonly size: TitleSize;
}

/** Shapes `text` as one line at `fontSizePx`, in font units scaled to pixels (same boundary `layoutSegment` uses). */
function shapeTitle(
  text: string,
  script: WordScript | undefined,
  style: StyleDoc,
  registry: FontRegistry,
  shaper: Shaper,
  fontSizePx: number,
): ShapedTitle {
  const resolvedScript = script ?? "latin";
  const codePoints = codePointsOf(text);
  const font = resolveFontOrThrow(
    registry,
    {
      family: style.typography.fontFamily,
      // A title is drawn heavier than the caption it borrows its family
      // from, so it reads as a title rather than another caption line.
      weight: Math.min(900, style.typography.weight + 200),
      italic: false,
      ...(style.typography.fallbacks === undefined
        ? {}
        : { fallbacks: style.typography.fallbacks }),
      script: resolvedScript,
    },
    codePoints,
  );
  const shaped = shaper.shape({ text, fontId: font.id, script: resolvedScript });
  const metrics = shaper.metrics(font.id);
  const scale = fontSizePx / metrics.upem;

  const glyphs: number[] = [];
  const positions: number[] = [];
  const clusters: number[] = [];
  let x = 0;
  for (const glyph of shaped.glyphs) {
    glyphs.push(glyph.id);
    positions.push(x + glyph.xOffset * scale, glyph.yOffset * scale);
    clusters.push(glyph.cluster);
    x += glyph.xAdvance * scale;
  }
  const width = x;
  const height = (metrics.ascender - metrics.descender) * scale;
  return {
    run: { fontId: font.id, fontSizePx, glyphs, positions, clusters, text },
    size: { width, height: height * TITLE_BOX_LINE_FACTOR },
  };
}

/** Moves a shaped run's glyph origin so the run sits centred inside `box`. */
function runCentredInBox(run: GlyphRun, size: TitleSize, box: Rect): GlyphRun {
  const left = box[0] + (box[2] - box[0] - size.width) / 2;
  // Baseline a touch below box centre: ascender/descender make the visual
  // centre of a glyph run sit slightly above its metrics box's own middle.
  const baseline = (box[1] + box[3]) / 2 + size.height * 0.32;
  const positions: number[] = [];
  for (let index = 0; index < run.positions.length; index += 2) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, index-bounded loop counter, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const x = run.positions[index] as number;
    const y = run.positions[index + 1] as number;
    positions.push(x + left, y + baseline);
  }
  return { ...run, positions };
}

/** Title items live at `sourceMs` (D06's convention, same as a keyframe track), in `itemId` order for determinism. */
function activeTitles(titles: readonly TitleFxTrack[], sourceMs: number): readonly TitleFxTrack[] {
  return titles
    .filter((title) => sourceMs >= title.startMs && sourceMs < title.endMs)
    .slice()
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/**
 * The rectangle `placeTitleBox` must not overlap, from `layoutFrame`'s own
 * result for the same frame — the caption's `paddedBox` (its block/safe-area
 * rectangle) union'd across every caption on screen at once (podcast styles
 * can show two speakers' lines at a time), or `undefined` when none is.
 */
export function captionBoxFromLayouts(
  layouts: readonly { readonly layout: Layout }[],
): Rect | undefined {
  let box: Rect | undefined;
  for (const { layout } of layouts) {
    const padded = layout.paddedBox;
    box =
      box === undefined
        ? padded
        : [
            Math.min(box[0], padded[0]),
            Math.min(box[1], padded[1]),
            Math.max(box[2], padded[2]),
            Math.max(box[3], padded[3]),
          ];
  }
  return box;
}

/**
 * The frame's title commands: every accepted title on screen at `outputMs`,
 * drawn after (so: on top of) whatever caption commands the caller already
 * built for the same frame — the brief's "draw titles after captions".
 */
export function renderTitleFrame(options: RenderTitlesOptions): DrawCommand[] {
  const { titles, timemap, style, registry, shaper } = options;
  if (titles.length === 0) return [];
  const canvas = assertCanvas(options.canvas);
  const sourceMs = timemap === null ? options.outputMs : timemap.toSource(options.outputMs);
  const fontSizePx = titleFontSizePx(canvas);

  const commands: DrawCommand[] = [];
  for (const title of activeTitles(titles, sourceMs)) {
    const totalMs = Math.max(1, title.endMs - title.startMs);
    const progressValue = textFxProgress(sourceMs, title.startMs, title.endMs);
    const phase = textFxPhase(title.motionPreset, progressValue, totalMs);
    if (phase.opacity <= 0) continue;

    const script = detectWordScript(title.text);
    const displayText =
      title.motionPreset === "count-up"
        ? countUpText(title.text, phase.countFraction, script)
        : title.text;

    const shaped = shapeTitle(displayText, script, style, registry, shaper, fontSizePx);
    const placement = placeTitleBox({
      canvas,
      captionBox: options.captionBox,
      title: shaped.size,
    });
    const positionedRun = runCentredInBox(shaped.run, shaped.size, placement.box);

    commands.push(
      ...drawTextFxTitle({
        box: placement.box,
        phase,
        glyphRun: positionedRun,
        // A title borrows the caption style's own text colour (module doc
        // comment above); `drawTextFxTitle`'s `textColor` is a flat `Color`
        // (`commands/types.ts`), so a `Gradient` `colors.text` (K08) resolves
        // to its first stop — titles are out of this WP's scope (word ink
        // only), matching every other solid-only reader of this field.
        textColor: resolveColour(style.colors.text),
        ...(style.colors.accent === undefined ? {} : { accentColor: style.colors.accent }),
        showUnderline: title.motionPreset === "underline",
      }),
    );
  }
  return commands;
}
