/**
 * A brand kit's end card (2026-10-02): over the last seconds of a clip the
 * frame dims to the card's colour and a call to action ("Follow for more"), a
 * handle ("@yourname") and the logo come up. It lives on the document as an
 * overlay (`EdgHot.overlays`, kind `end-card`), and this module is the one place
 * it becomes pixels, so every surface draws the same card. The clip keeps its
 * length: the card covers its end, it is not added after it.
 *
 * **Two layers.** The dim ({@link drawEndCardBackdrop}) is drawn *under* the
 * captions, so a line still being spoken stays readable on top of it; the
 * card's content ({@link drawEndCardContent}) is drawn over them, in space the
 * captions leave free.
 *
 * **What it looks like.** A centred stack: the logo, the call to action in the
 * kit's typeface (else the document style's) at a heavy weight, and the handle
 * smaller in the kit's accent colour. The words keep their own letter case — a
 * handle is case-sensitive. Ink is the kit's, else black or white, whichever
 * reads on the card's colour.
 *
 * **Where it goes.** Centred in the frame if the captions shown while it is up
 * leave room there; else centred in the space above the captions, else below
 * them; each tried at full size, then 80 % and 65 %. If nothing clears them it
 * stays centred at 65 %.
 *
 * Pure: the same inputs give the same `DrawCommand[]` on every backend.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { easeOutCubic } from "../animate/easing.js";
import { contrastingInk, setAlpha } from "../colour.js";
import { fill, group, rect, text, transform } from "../commands/build.js";
import { type DrawCommand, type Rect } from "../commands/types.js";
import { isRenderError } from "../errors.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout, type RenderWord } from "../layout/types.js";
import { assertCanvas, type CanvasSize, clamp01, q } from "../units.js";
import { glyphRunOf } from "./hook-title.js";
import { type EndCardTrack } from "./types.js";

/** How far the frame dims, at full: the video still shows through. */
export const END_CARD_DIM = 0.84;
const BACKDROP_FADE_MS = 400;
const CONTENT_DELAY_MS = 120;
const CONTENT_FADE_MS = 380;

/** Type sizes and the logo's height, as shares of the frame's short side. */
const CTA_SIZE = 0.075;
const HANDLE_SIZE = 0.045;
const LOGO_HEIGHT = 0.16;
/** The widest the logo may be, as a share of the frame's width. */
const LOGO_MAX_WIDTH = 0.45;
/** Between the stack's parts, and kept clear at the frame's top and bottom. */
const GAP = 0.03;
const MARGIN = 0.06;
/** Air between the stack and a caption it moved off, as a share of the height. */
const CAPTION_GAP = 0.02;
const CTA_MAX_LINES = 3;
const MAX_WIDTH_PORTRAIT_PCT = 82;
const MAX_WIDTH_LANDSCAPE_PCT = 60;

const SCALES = [1, 0.8, 0.65] as const;

/** A laid-out, placed end card: what the two draw calls draw, frame after frame. */
export interface EndCardLayout {
  readonly overlayId: string;
  readonly startMs: number;
  readonly endMs: number;
  /** The card's colour, opaque. */
  readonly background: string;
  readonly textColour: string;
  readonly accentColour: string;
  readonly logo?: { readonly assetId: string; readonly dest: Rect };
  readonly cta?: Layout;
  readonly handle?: Layout;
  /** Everything the stack covers. */
  readonly box: Rect;
  /** 1 at full size; smaller when it shrank to clear the captions. */
  readonly scale: number;
}

export interface EndCardInput {
  readonly overlay: EndCardTrack;
  /** The document's own style: the typeface when the kit names none. */
  readonly style: StyleDoc;
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** What the captions cover while the card is up, in canvas pixels. */
  readonly captions?: readonly Rect[];
}

function isPortrait(canvas: CanvasSize): boolean {
  return canvas.height > canvas.width * 1.1;
}

/**
 * A line of the card as the layout engine wants it: the document's typeface
 * (or the kit's), at `fontPx`, centred, in the words' own case, with none of a
 * caption's behaviour (chunks, one word at a time, its own box).
 */
function lineStyleOf(
  style: StyleDoc,
  canvas: CanvasSize,
  fontPx: number,
  weight: number,
  maxLines: number,
  fontFamily: string | undefined,
): StyleDoc {
  const { typographyMotion: _motion, ...animation } = style.animation;
  return {
    ...style,
    typography: {
      ...style.typography,
      ...(fontFamily === undefined ? {} : { fontFamily }),
      weight,
      sizePct: (fontPx / canvas.height) * 100,
      lineHeight: 1.12,
      letterSpacingEm: 0,
      textTransform: "none",
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
      maxLines,
      safeAreaPct: 0,
    },
    animation: { ...animation, perWord: false },
    emphasisPresets: [],
  };
}

function wordsOf(id: string, line: string, startMs: number, endMs: number): RenderWord[] {
  return line
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word, index) => ({ wid: `${id}:${String(index)}`, t: word, s: startMs, e: endMs }));
}

interface LineSpec {
  readonly key: "cta" | "handle";
  readonly text: string;
  readonly fontPx: number;
  readonly weight: number;
  readonly maxLines: number;
}

/** One line of the card laid out with its top at `top`, or `undefined` if it cannot be. */
function layLine(input: EndCardInput, spec: LineSpec, top: number): Layout | undefined {
  const { overlay, canvas } = input;
  const words = wordsOf(`${overlay.id}:${spec.key}`, spec.text, overlay.startMs, overlay.endMs);
  if (words.length === 0) return undefined;
  try {
    return layoutSegment({
      style: lineStyleOf(
        input.style,
        canvas,
        spec.fontPx,
        spec.weight,
        spec.maxLines,
        overlay.fontFamily,
      ),
      segment: {
        id: `${overlay.id}:${spec.key}`,
        startMs: overlay.startMs,
        endMs: overlay.endMs,
        position: { x: 0.5, y: top / canvas.height, anchor: "top-center" },
      },
      words,
      canvas,
      registry: input.registry,
      shaper: input.shaper,
      tMs: overlay.startMs,
    });
  } catch (error) {
    // A line that cannot be laid out (no face covers it) is left off the card
    // rather than taking the frame, and the captions under it, down with it.
    if (isRenderError(error)) return undefined;
    throw error;
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

interface Stack {
  readonly scale: number;
  readonly lines: readonly LineSpec[];
  /** Heights in stack order: the logo (when there is one), then each line. */
  readonly logoSize?: { readonly width: number; readonly height: number };
  readonly lineHeights: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly gap: number;
}

function measureStack(input: EndCardInput, scale: number): Stack {
  const { overlay, canvas } = input;
  const shortSide = Math.min(canvas.width, canvas.height);
  const gap = shortSide * GAP * scale;
  const lines: LineSpec[] = [];
  const cta = overlay.cta?.trim() ?? "";
  const handle = overlay.handle?.trim() ?? "";
  if (cta !== "") {
    lines.push({
      key: "cta",
      text: cta,
      fontPx: shortSide * CTA_SIZE * scale,
      weight: 800,
      maxLines: CTA_MAX_LINES,
    });
  }
  if (handle !== "") {
    lines.push({
      key: "handle",
      text: handle,
      fontPx: shortSide * HANDLE_SIZE * scale,
      weight: 600,
      maxLines: 1,
    });
  }

  let logoSize: { width: number; height: number } | undefined;
  const image = overlay.image;
  if (image !== undefined && image.width > 0 && image.height > 0) {
    let height = shortSide * LOGO_HEIGHT * scale;
    let width = (height * image.width) / image.height;
    const widest = canvas.width * LOGO_MAX_WIDTH * scale;
    if (width > widest) {
      height = (height * widest) / width;
      width = widest;
    }
    logoSize = { width, height };
  }

  const measured: { spec: LineSpec; layout: Layout }[] = [];
  for (const spec of lines) {
    const layout = layLine(input, spec, 0);
    if (layout !== undefined) measured.push({ spec, layout });
  }
  const lineHeights = measured.map(({ layout }) => layout.box[3] - layout.box[1]);
  const widths = [
    ...(logoSize === undefined ? [] : [logoSize.width]),
    ...measured.map(({ layout }) => layout.box[2] - layout.box[0]),
  ];
  const parts = (logoSize === undefined ? 0 : 1) + lineHeights.length;
  return {
    scale,
    lines: measured.map(({ spec }) => spec),
    ...(logoSize === undefined ? {} : { logoSize }),
    lineHeights,
    width: widths.length === 0 ? 0 : Math.max(...widths),
    height:
      (logoSize?.height ?? 0) +
      lineHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, parts - 1) * gap,
    gap,
  };
}

/**
 * Lays out and places one end card ({@link EndCardLayout}), or `undefined`
 * when it has nothing to show (no words laid out and no logo).
 */
export function layoutEndCard(input: EndCardInput): EndCardLayout | undefined {
  const canvas = assertCanvas(input.canvas);
  const { overlay } = input;
  const captions = input.captions ?? [];
  const shortSide = Math.min(canvas.width, canvas.height);
  const margin = shortSide * MARGIN;
  const captionGap = canvas.height * CAPTION_GAP;
  const captionTop = captions.length === 0 ? undefined : Math.min(...captions.map((box) => box[1]));
  const captionBottom =
    captions.length === 0 ? undefined : Math.max(...captions.map((box) => box[3]));

  const stackRect = (stack: Stack, top: number): Rect => [
    (canvas.width - stack.width) / 2,
    top,
    (canvas.width + stack.width) / 2,
    top + stack.height,
  ];
  const fits = (stack: Stack, top: number): boolean =>
    top >= margin - 0.5 &&
    top + stack.height <= canvas.height - margin + 0.5 &&
    !captions.some((box) => overlaps(box, stackRect(stack, top)));
  const tops = (stack: Stack): number[] => {
    const centred = (canvas.height - stack.height) / 2;
    const found = [centred];
    if (captionTop !== undefined) {
      // Centred in the space above the captions, then in the space below.
      found.push((margin + captionTop - captionGap - stack.height) / 2);
    }
    if (captionBottom !== undefined) {
      found.push((captionBottom + captionGap + canvas.height - margin - stack.height) / 2);
    }
    return found;
  };

  let chosen: { stack: Stack; top: number } | undefined;
  let last: Stack | undefined;
  search: for (const scale of SCALES) {
    const stack = measureStack(input, scale);
    last = stack;
    if (stack.height <= 0) return undefined;
    for (const top of tops(stack)) {
      if (fits(stack, top)) {
        chosen = { stack, top };
        break search;
      }
    }
  }
  if (chosen === undefined) {
    if (last === undefined || last.height <= 0) return undefined;
    chosen = { stack: last, top: (canvas.height - last.height) / 2 };
  }

  const { stack } = chosen;
  let cursor = chosen.top;
  let logo: EndCardLayout["logo"];
  if (stack.logoSize !== undefined && overlay.image !== undefined) {
    const left = (canvas.width - stack.logoSize.width) / 2;
    logo = {
      assetId: overlay.image.assetId,
      dest: [q(left), q(cursor), q(left + stack.logoSize.width), q(cursor + stack.logoSize.height)],
    };
    cursor += stack.logoSize.height + stack.gap;
  }
  let cta: Layout | undefined;
  let handle: Layout | undefined;
  stack.lines.forEach((spec, index) => {
    const layout = layLine(input, spec, cursor);
    if (layout !== undefined) {
      if (spec.key === "cta") cta = layout;
      else handle = layout;
    }
    cursor += (stack.lineHeights.at(index) ?? 0) + stack.gap;
  });

  const background = setAlpha(overlay.background, 1);
  const textColour =
    overlay.text === undefined ? contrastingInk(background) : setAlpha(overlay.text, 1);
  const box = stackRect(stack, chosen.top);
  return {
    overlayId: overlay.id,
    startMs: overlay.startMs,
    endMs: overlay.endMs,
    background,
    textColour,
    accentColour: overlay.accent === undefined ? textColour : setAlpha(overlay.accent, 1),
    ...(logo === undefined ? {} : { logo }),
    ...(cta === undefined ? {} : { cta }),
    ...(handle === undefined ? {} : { handle }),
    box: [q(box[0]), q(box[1]), q(box[2]), q(box[3])],
    scale: stack.scale,
  };
}

/**
 * How far the card has come in at `tMs`: 0 before it starts, rising to 1 over
 * its first {@link BACKDROP_FADE_MS}. The corner logo fades out by the same
 * amount.
 */
export function endCardProgress(tMs: number, startMs: number, endMs: number): number {
  if (tMs < startMs || tMs >= endMs) return 0;
  const fadeMs = Math.min(BACKDROP_FADE_MS, Math.max(1, (endMs - startMs) * 0.3));
  return easeOutCubic((tMs - startMs) / fadeMs);
}

/** The dimmed frame under the captions, at one instant. Only the track and the canvas decide it. */
export function drawEndCardBackdrop(
  overlay: Pick<EndCardTrack, "id" | "startMs" | "endMs" | "background">,
  canvas: CanvasSize,
  tMs: number,
): DrawCommand[] {
  const progress = endCardProgress(tMs, overlay.startMs, overlay.endMs);
  if (progress <= 0) return [];
  return [
    group(
      [
        rect([0, 0, canvas.width, canvas.height], {
          fill: fill(setAlpha(overlay.background, 1), END_CARD_DIM * progress),
        }),
      ],
      `end-card-backdrop:${overlay.id}`,
    ),
  ];
}

/**
 * The card's logo and words at one instant, over the captions: they come up a
 * beat after the dim, rising a little as they fade in.
 */
export function drawEndCardContent(card: EndCardLayout, tMs: number): DrawCommand[] {
  if (tMs < card.startMs || tMs >= card.endMs) return [];
  const total = Math.max(1, card.endMs - card.startMs);
  const delayMs = Math.min(CONTENT_DELAY_MS, total * 0.1);
  const fadeMs = Math.min(CONTENT_FADE_MS, total * 0.3);
  const enter = easeOutCubic(clamp01((tMs - card.startMs - delayMs) / fadeMs));
  if (enter <= 0) return [];

  const children: DrawCommand[] = [];
  if (card.logo !== undefined) {
    children.push({ kind: "image", assetId: card.logo.assetId, dest: card.logo.dest });
  }
  for (const [layout, colour] of [
    [card.cta, card.textColour],
    [card.handle, card.accentColour],
  ] as const) {
    if (layout === undefined) continue;
    for (const line of layout.lines) {
      for (const run of line.runs) {
        children.push(text(glyphRunOf(run), { fill: fill(colour) }));
      }
    }
  }
  if (children.length === 0) return [];
  const rise = (1 - enter) * (card.box[3] - card.box[1]) * 0.06;
  const content = group(children, `end-card:${card.overlayId}`, enter);
  return [rise <= 0 ? content : transform([1, 0, 0, 1, 0, q(rise)], [content])];
}
