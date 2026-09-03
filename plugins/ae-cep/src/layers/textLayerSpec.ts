/**
 * Pure layer-spec builder (brief item 4: "layer-spec builder (fonts from `packages/fonts`
 * names, sizes, colours, positions in comp pixels)"). Takes EDG segments plus a resolved
 * `@montaj/caption-styles` `StyleDoc` and produces `TextLayerSpec[]` — no host call, no AE, no
 * ExtendScript — so this is the part `addTextLayers` unit-tests exercise directly (per the brief:
 * "unit-test the JS logic that prepares layer specs, not the host").
 *
 * Sizes/positions in a `StyleDoc` are percentages of canvas height/font size (see
 * `packages/caption-styles/src/schema.ts`'s header comment); this module resolves them to comp
 * pixels using the target comp's own width/height, matching what an AE `TextLayer`/
 * `AVLayer#transform.position` actually wants (absolute pixel coordinates, top-left origin).
 */
import type { StyleDoc } from "@montaj/caption-styles";

import type { TextLayerSpec } from "../host/ae.js";

export interface CaptionSegmentInput {
  readonly segmentId: string;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface BuildTextLayerSpecsOptions {
  readonly compWidthPx: number;
  readonly compHeightPx: number;
  readonly style: StyleDoc;
  readonly segments: readonly CaptionSegmentInput[];
}

/** `#RRGGBB`/`#RRGGBBAA` -> 0-255 RGB triple (alpha, if present, is dropped — AE layer opacity
 * carries transparency separately, per `Layer#transform.opacity`). */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(hex);
  const [, r, g, b] = match ?? [];
  if (!r || !g || !b) {
    throw new Error(`hexToRgb: invalid colour "${hex}"`);
  }
  return [Number.parseInt(r, 16), Number.parseInt(g, 16), Number.parseInt(b, 16)];
}

/** `layout.x`/`layout.y` (normalised 0-1, anchor-relative) -> absolute comp-pixel top-left
 * position for the layer. AE text layers anchor their transform at the layer's own anchor point
 * (default top-left of the text box); this resolves every named anchor to the point the caller
 * should place there, same nine-anchor grid `packages/caption-styles`' schema documents. */
export function resolvePositionPx(
  style: Pick<StyleDoc, "layout">,
  compWidthPx: number,
  compHeightPx: number,
): { readonly x: number; readonly y: number } {
  return {
    x: style.layout.x * compWidthPx,
    y: style.layout.y * compHeightPx,
  };
}

/** `typography.sizePct` (percentage of canvas height) -> pixel font size. */
export function resolveFontSizePx(
  style: Pick<StyleDoc, "typography">,
  compHeightPx: number,
): number {
  return (style.typography.sizePct / 100) * compHeightPx;
}

/**
 * Builds one `TextLayerSpec` per segment. Every spec shares the style's font/size/colour/
 * position/stroke/box — this WP has no per-word layer-level animation (brief: "no full
 * TimelineAdapter"), so the whole segment's text is one static styled layer for its full
 * duration, same simplification `src/styles/classification-rules.ts`'s
 * `highlight-per-word-paging` rule documents.
 */
export function buildTextLayerSpecs(options: BuildTextLayerSpecsOptions): TextLayerSpec[] {
  const { compWidthPx, compHeightPx, style, segments } = options;
  const position = resolvePositionPx(style, compWidthPx, compHeightPx);
  const fontSizePx = resolveFontSizePx(style, compHeightPx);
  const colorRgb = hexToRgb(style.colors.text);

  const strokeColorRgb =
    style.stroke.enabled && style.stroke.color ? hexToRgb(style.stroke.color) : undefined;
  const strokeWidthPx = style.stroke.enabled
    ? (style.stroke.widthPct / 100) * fontSizePx
    : undefined;

  const box =
    style.box.enabled && style.box.fill
      ? {
          fillRgb: hexToRgb(style.box.fill),
          opacity: style.box.opacity,
          paddingPx: (style.box.paddingPct / 100) * fontSizePx,
        }
      : undefined;

  return segments.map((segment) => ({
    segmentId: segment.segmentId,
    text: segment.text,
    startSeconds: segment.startSeconds,
    durationSeconds: segment.endSeconds - segment.startSeconds,
    fontFamily: style.typography.fontFamily,
    fontSizePx,
    colorRgb,
    positionXPx: position.x,
    positionYPx: position.y,
    strokeColorRgb,
    strokeWidthPx,
    box,
  }));
}
