/**
 * `renderFrame` — one output millisecond of a project as `DrawCommand[]`.
 *
 * The output clock is the timeline's, the segments live on the source clock, so
 * the first thing that happens is `timemap.toSource(outputMs)` (decision D30).
 * Everything after that is the pure pipeline: resolve the style, resolve the
 * words, lay out, animate.
 *
 * Captions are emitted in `seq` order so two segments that overlap (a title over
 * a caption) stack the same way on every backend.
 */

import { type StyleDoc } from "@montaj/caption-styles";
import { type TimeQuery } from "@montaj/timemap";

import {
  captionExtent,
  type CanvasFaceTrack,
  combineShrink,
  PlacementCache,
  placeCaption,
  placementKey,
} from "./placement.js";
import { type EdgProjection, visibleSegments, wordsBetween } from "./projection.js";
import { type DisplayScript, resolveStyle, resolveWords } from "./resolve.js";
import { type TrackShrink, trackShrinkFor } from "./track-shrink.js";
import { animate } from "../animate/animate.js";
import { type DrawCommand, type Rect } from "../commands/types.js";
import { isRenderError } from "../errors.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout } from "../layout/types.js";
import {
  drawEndCardBackdrop,
  drawEndCardContent,
  type EndCardLayout,
  endCardProgress,
  layoutEndCard,
} from "../overlay/end-card.js";
import { HookTitleCache, renderHookTitles } from "../overlay/hook-title.js";
import { drawLogo, type LogoPlacement, placeLogo } from "../overlay/logo.js";
import { type EndCardTrack, type LogoTrack, OverlayLayoutCache } from "../overlay/types.js";
import { type CanvasSize, assertCanvas } from "../units.js";

export interface RenderFrameOptions {
  readonly projection: EdgProjection;
  /** `null` when the project has no edits: output time is source time. */
  readonly timemap: TimeQuery | null;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** Overrides the projection's canvas, e.g. to preview at the 540p proxy size. */
  readonly canvas?: CanvasSize;
  readonly outputMs: number;
  /** Which of a word's scripts to show; defaults to the transcript's own text. */
  readonly script?: DisplayScript;
  readonly dropFillers?: boolean;
  /** Re-used across frames so style merging is not redone thirty times a second. */
  readonly styleCache?: Map<string, StyleDoc>;
  /**
   * One shrink per (style, script) for the whole caption track, from
   * `computeTrackShrink`. With it, every caption in a style is drawn at the same
   * size for the whole video; without it, each caption shrinks on its own.
   * Compute it once per session and cache it — it costs one layout per caption.
   */
  readonly trackShrink?: TrackShrink;
  /**
   * K07: overall opacity (`0`-`1`) of the whole caption overlay, passed
   * straight through to every visible segment's `animate()` call — see
   * `AnimateOptions.captionOpacity`'s doc comment for how it composites with
   * a cue's own fade in/out. `undefined` (every caller before this field
   * existed, including every fixture and golden-hash test) renders exactly
   * as before: `animate` defaults it to fully opaque.
   */
  readonly captionOpacity?: number;
  /**
   * Where the faces are (`faceTrackOnCanvas` over the media's `faces.json`).
   * With it, a caption that would cover a face moves off it, and shrinks if it
   * must (`placement.ts`); without it, every caption sits where its style says.
   */
  readonly faces?: CanvasFaceTrack;
  /** Re-used across frames so each caption is placed once, not thirty times a second. */
  readonly placementCache?: PlacementCache;
  /**
   * Re-used across frames so a hook title (`projection.overlays`) is laid out
   * and placed once, not thirty times a second. A shared one is used without it.
   */
  readonly hookTitleCache?: HookTitleCache;
}

/** Used when a caller passes faces but no cache: still once per caption per module. */
const SHARED_PLACEMENTS = new PlacementCache();

/** Used when a caller passes no hook-title cache. Weakly keyed by projection. */
const SHARED_HOOK_TITLES = new HookTitleCache();

/** Brand logos and end cards (2026-10-02), placed once per document. Weakly keyed by projection. */
const SHARED_LOGOS = new OverlayLayoutCache<LogoPlacement>();
const SHARED_END_CARDS = new OverlayLayoutCache<EndCardLayout>();

/** The layouts that make up one frame; `renderFrame` is this plus `animate`. */
export function layoutFrame(options: RenderFrameOptions): { layout: Layout; style: StyleDoc }[] {
  const { projection, timemap } = options;
  const canvas = assertCanvas(options.canvas ?? projection.canvas);
  const sourceMs = timemap === null ? options.outputMs : timemap.toSource(options.outputMs);
  return layoutAtSource(options, canvas, sourceMs);
}

/** {@link layoutFrame} at an instant already on the source clock. */
function layoutAtSource(
  options: RenderFrameOptions,
  canvas: CanvasSize,
  sourceMs: number,
): { layout: Layout; style: StyleDoc }[] {
  const { projection, catalogue, registry, shaper } = options;
  const source = {
    catalogue,
    defaultStyleId: projection.styles.defaultStyleId,
    ...(projection.styles.inline?.doc === undefined
      ? {}
      : { documentOverrides: projection.styles.inline.doc }),
  };

  const results: { layout: Layout; style: StyleDoc }[] = [];
  for (const segment of visibleSegments(projection.segments, sourceMs)) {
    const style = resolveStyle(source, segment, options.styleCache);
    const words = resolveWords({
      segment,
      words: wordsBetween(projection.words, segment.startWordId, segment.endWordId),
      script: options.script ?? "roman",
      ...(options.dropFillers === undefined ? {} : { dropFillers: options.dropFillers }),
    });
    if (words.length === 0) continue;
    // Resolved after the layout knows which script it is drawing, because the
    // track keeps a separate size per script.
    const trackShrink = (script: Parameters<typeof trackShrinkFor>[2]) =>
      trackShrinkFor(options.trackShrink, style.id, script);
    const faces = options.faces;
    const placement =
      faces === undefined
        ? undefined
        : (options.placementCache ?? SHARED_PLACEMENTS).get(
            style,
            placementKey(segment, words, canvas, faces),
            () =>
              placeCaption({
                style,
                segment,
                words,
                canvas,
                registry,
                shaper,
                faces,
                shrinkOverride: trackShrink,
              }),
          );
    results.push({
      style,
      layout: layoutSegment({
        style,
        segment: placement === undefined ? segment : { ...segment, position: placement.position },
        words,
        canvas,
        registry,
        shaper,
        tMs: sourceMs,
        shrinkOverride: (script) => combineShrink(trackShrink(script), placement?.shrink),
      }),
    });
  }
  return results;
}

export function renderFrame(options: RenderFrameOptions): DrawCommand[] {
  const { projection, timemap } = options;
  const sourceMs = timemap === null ? options.outputMs : timemap.toSource(options.outputMs);
  const watermarkAssetId = projection.render?.watermarkAssetId;
  const overlays = projection.overlays ?? [];

  const commands: DrawCommand[] = [];
  // An end card's dim goes under the captions (2026-10-02), so a line still
  // being spoken reads on top of it. Only a document with an end card on
  // screen draws anything here.
  for (const overlay of overlays) {
    if (overlay.kind !== "end-card") continue;
    commands.push(
      ...drawEndCardBackdrop(overlay, assertCanvas(options.canvas ?? projection.canvas), sourceMs),
    );
  }
  for (const { layout, style } of layoutFrame(options)) {
    commands.push(
      ...animate({
        layout,
        style,
        tMs: sourceMs,
        ...(projection.speakerColours === undefined
          ? {}
          : { speakerColours: projection.speakerColours }),
        ...(options.captionOpacity === undefined ? {} : { captionOpacity: options.captionOpacity }),
      }),
    );
  }
  // The hook title, a logo and an end card's content sit over the captions
  // (they never share their space). Only a projection that carries overlays
  // reaches this; every other frame is the same list it was before overlays
  // existed.
  if (overlays.length > 0) {
    commands.push(...overlayCommands(options, sourceMs));
  }
  if (watermarkAssetId !== undefined && commands.length >= 0) {
    const canvas = assertCanvas(options.canvas ?? projection.canvas);
    commands.push(watermarkFor(watermarkAssetId, canvas));
  }
  return commands;
}

/**
 * The frame's overlays (`projection.overlays`), drawn in the document's own
 * style — its default with the document overrides, the same one a caption
 * without a style of its own is drawn in — and kept off the captions shown
 * while each one is up, as well as off the faces.
 *
 * A brand logo (2026-10-02) is placed first, off the captions; the hook title
 * then keeps off the captions and the logo; an end card's content keeps off
 * the captions shown under it, and the corner logo fades out as it comes in.
 */
function overlayCommands(options: RenderFrameOptions, sourceMs: number): DrawCommand[] {
  const { projection } = options;
  const overlays = projection.overlays ?? [];
  const canvas = assertCanvas(options.canvas ?? projection.canvas);
  let style: StyleDoc | undefined;
  try {
    style = resolveStyle(
      {
        catalogue: options.catalogue,
        defaultStyleId: projection.styles.defaultStyleId,
        ...(projection.styles.inline?.doc === undefined
          ? {}
          : { documentOverrides: projection.styles.inline.doc }),
      },
      {},
      options.styleCache,
    );
  } catch (error) {
    if (!isRenderError(error)) throw error;
    style = undefined;
  }
  const commands: DrawCommand[] = [];
  const logos = logoPlacements(options, canvas, style);
  if (logos.length > 0) {
    let card = 0;
    for (const overlay of overlays) {
      if (overlay.kind !== "end-card") continue;
      card = Math.max(card, endCardProgress(sourceMs, overlay.startMs, overlay.endMs));
    }
    for (const logo of logos) {
      if (sourceMs < logo.startMs || sourceMs >= logo.endMs) continue;
      commands.push(...drawLogo(logo, 1 - card));
    }
  }

  commands.push(
    ...renderHookTitles({
      overlays,
      sourceMs,
      style,
      canvas,
      registry: options.registry,
      shaper: options.shaper,
      ...(options.faces === undefined ? {} : { faces: options.faces }),
      captionsDuring: (startMs, endMs) => [
        ...captionExtentsDuring(options, canvas, startMs, endMs),
        // A logo up at the same time is one more thing to keep off.
        ...logos
          .filter((logo) => logo.startMs < endMs && logo.endMs > startMs)
          .map((logo) => logo.dest),
      ],
      cache: options.hookTitleCache ?? SHARED_HOOK_TITLES,
      cacheOwner: projection,
    }),
  );

  if (style !== undefined) {
    const cardStyle = style;
    for (const overlay of overlays) {
      if (overlay.kind !== "end-card") continue;
      if (sourceMs < overlay.startMs || sourceMs >= overlay.endMs) continue;
      const card = SHARED_END_CARDS.get(
        projection,
        brandOverlayKey(overlay, options, canvas, cardStyle),
        () =>
          layoutEndCard({
            overlay,
            style: cardStyle,
            canvas,
            registry: options.registry,
            shaper: options.shaper,
            captions: safeCaptionExtents(options, canvas, overlay.startMs, overlay.endMs),
          }),
      );
      if (card !== undefined) commands.push(...drawEndCardContent(card, sourceMs));
    }
  }
  return commands;
}

/**
 * What decides a brand overlay's place besides the projection itself (the
 * cache's owner): the overlay, the canvas, the style, the face track and which
 * of the words' scripts the captions are drawn in.
 */
function brandOverlayKey(
  overlay: LogoTrack | EndCardTrack,
  options: RenderFrameOptions,
  canvas: CanvasSize,
  style: StyleDoc | undefined,
): string {
  return [
    JSON.stringify(overlay),
    canvas.width,
    canvas.height,
    style?.id ?? "-",
    options.faces === undefined ? "-" : String(options.faces.times.length),
    options.script ?? "roman",
    options.dropFillers === true ? "drop" : "keep",
  ].join("|");
}

/** Every logo in the document, placed off the captions shown while it is up. */
function logoPlacements(
  options: RenderFrameOptions,
  canvas: CanvasSize,
  style: StyleDoc | undefined,
): LogoPlacement[] {
  const placements: LogoPlacement[] = [];
  for (const overlay of options.projection.overlays ?? []) {
    if (overlay.kind !== "logo") continue;
    const placement = SHARED_LOGOS.get(
      options.projection,
      brandOverlayKey(overlay, options, canvas, style),
      () =>
        placeLogo(
          overlay,
          canvas,
          safeCaptionExtents(options, canvas, overlay.startMs, overlay.endMs),
        ),
    );
    if (placement !== undefined) placements.push(placement);
  }
  return placements;
}

/**
 * {@link captionExtentsDuring}, or nothing to avoid when the captions cannot be
 * laid out: a caption the frame cannot draw is not one a logo has to dodge.
 */
function safeCaptionExtents(
  options: RenderFrameOptions,
  canvas: CanvasSize,
  startMs: number,
  endMs: number,
): Rect[] {
  try {
    return captionExtentsDuring(options, canvas, startMs, endMs);
  } catch (error) {
    if (isRenderError(error)) return [];
    throw error;
  }
}

/**
 * Everything the captions draw during `[startMs, endMs)` on the source clock:
 * each caption on screen then, laid out at its start and at every word that
 * starts inside the window (a style that shows words in chunks, or one word at
 * a time, changes shape at each), placed off the faces exactly as it is drawn.
 */
function captionExtentsDuring(
  options: RenderFrameOptions,
  canvas: CanvasSize,
  startMs: number,
  endMs: number,
): Rect[] {
  const { projection } = options;
  const instants = new Set<number>();
  for (const segment of projection.segments) {
    if (segment.hidden === true || segment.endMs <= startMs || segment.startMs >= endMs) continue;
    instants.add(Math.max(segment.startMs, startMs));
    for (const word of wordsBetween(projection.words, segment.startWordId, segment.endWordId)) {
      if (word.s > startMs && word.s < endMs) instants.add(word.s);
    }
  }
  const extents: Rect[] = [];
  for (const instant of [...instants].sort((a, b) => a - b)) {
    for (const { layout } of layoutAtSource(options, canvas, instant)) {
      extents.push(captionExtent(layout));
    }
  }
  return extents;
}

/** The watermark rectangle, independent of whether any caption is on screen. */
export function watermarkFor(assetId: string, canvas: CanvasSize): DrawCommand {
  const width = canvas.width * 0.18;
  const height = width * 0.28;
  const margin = canvas.height * 0.03;
  return {
    kind: "image",
    assetId,
    dest: [
      canvas.width - margin - width,
      canvas.height - margin - height,
      canvas.width - margin,
      canvas.height - margin,
    ],
    opacity: 0.85,
  };
}
