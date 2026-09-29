/**
 * A compilation's title card (2026-10-03): the title, the brand's handle and
 * logo on the brand's colour, for a couple of seconds before the first clip.
 *
 * It is drawn by the same code as the end card over the last seconds of every
 * branded clip (`@montaj/render-core` `layoutEndCard`/`drawEndCardContent`),
 * with the title as its call to action: the same stack, the same typeface and
 * fallbacks (Devanagari included), the same entrance - so a compilation opens
 * the way its clips close. Only the ground differs: the end card dims a clip's
 * last frames, the title card is a solid frame of the brand's colour.
 */

import type { StyleDoc } from "@montaj/caption-styles";
import {
  drawEndCardContent,
  layoutEndCard,
  type EndCardTrack,
  type FontRegistry,
  type Shaper,
} from "@montaj/render-core";
import type { SkiaNodeBackend } from "@montaj/render-skia-node";

import { framesOf } from "./plan.js";

import type { RenderCompilationPayload } from "../queues.js";

export type CompilationIntro = NonNullable<RenderCompilationPayload["intro"]>;

/** The card's overlay id: it only has to be unique on its own frame. */
export const INTRO_CARD_ID = "compilation-intro";

/**
 * The card as the end-card layout reads it. `withLogo` is false when the
 * logo's file could not be read: the card is then drawn without it rather than
 * the compilation failing over a logo.
 */
export function introCardTrack(intro: CompilationIntro, withLogo: boolean): EndCardTrack {
  const logo = withLogo ? intro.logo : undefined;
  return {
    id: INTRO_CARD_ID,
    kind: "end-card",
    startMs: 0,
    endMs: intro.durationMs,
    cta: intro.title,
    ...(intro.handle === undefined ? {} : { handle: intro.handle }),
    background: intro.background,
    ...(intro.text === undefined ? {} : { text: intro.text }),
    ...(intro.accent === undefined ? {} : { accent: intro.accent }),
    ...(intro.fontFamily === undefined ? {} : { fontFamily: intro.fontFamily }),
    ...(logo === undefined
      ? {}
      : {
          image: {
            assetId: logo.assetId,
            format: logo.format,
            width: logo.width,
            height: logo.height,
          },
        }),
  };
}

export interface CardFrames {
  readonly count: number;
  /** Frame `index` as straight RGBA; the buffer is reused by the next call. */
  frame(index: number): Uint8Array;
}

export interface CardInput {
  readonly intro: CompilationIntro;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** The typeface when the card names none: the product's default caption style. */
  readonly style: StyleDoc;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** With the logo registered under its asset id, when it is to be drawn. */
  readonly backend: SkiaNodeBackend;
  readonly withLogo: boolean;
}

/** The card, frame by frame: the brand's colour, and the stack coming up over it. */
export function cardFrames(input: CardInput): CardFrames {
  const { intro, width, height, fps } = input;
  const layout = layoutEndCard({
    overlay: introCardTrack(intro, input.withLogo),
    style: input.style,
    canvas: { width, height },
    registry: input.registry,
    shaper: input.shaper,
  });
  const batch = input.backend.createBatch({ width, height, background: intro.background });
  return {
    count: framesOf(intro.durationMs, fps),
    frame(index: number): Uint8Array {
      const tMs = (index * 1000) / fps;
      return batch.render(layout === undefined ? [] : drawEndCardContent(layout, tMs));
    },
  };
}
