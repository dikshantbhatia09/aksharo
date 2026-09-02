/**
 * The system style catalogue, as a browser-loadable module.
 *
 * The documents are imported as JSON and validated with the same schema the
 * server uses, so a malformed style fails the build rather than the render. The
 * imports are explicit because a bundler cannot follow a dynamic
 * `require("./" + id + ".json")`, and being explicit is what lets tree-shaking
 * drop the styles a page does not show.
 *
 * A14's API client replaces this with `GET /styles`, which also returns the
 * workspace's own presets; the shape a component receives does not change.
 */

import type { StyleDoc } from "@montaj/caption-styles";
import arcadePixel from "@montaj/caption-styles/styles/arcade-pixel.json";
import boldDrop from "@montaj/caption-styles/styles/bold-drop.json";
import boxBlock from "@montaj/caption-styles/styles/box-block.json";
import bubbleSoft from "@montaj/caption-styles/styles/bubble-soft.json";
import captionCard from "@montaj/caption-styles/styles/caption-card.json";
import duoTone from "@montaj/caption-styles/styles/duo-tone.json";
import glitchShift from "@montaj/caption-styles/styles/glitch-shift.json";
import gradientSweep from "@montaj/caption-styles/styles/gradient-sweep.json";
import highlightMarker from "@montaj/caption-styles/styles/highlight-marker.json";
import hypeBold from "@montaj/caption-styles/styles/hype-bold.json";
import impactShout from "@montaj/caption-styles/styles/impact-shout.json";
import karaokeFill from "@montaj/caption-styles/styles/karaoke-fill.json";
import liquidGlass from "@montaj/caption-styles/styles/liquid-glass.json";
import minimalLowerThird from "@montaj/caption-styles/styles/minimal-lower-third.json";
import neonGlow from "@montaj/caption-styles/styles/neon-glow.json";
import newsTicker from "@montaj/caption-styles/styles/news-ticker.json";
import outlineOnly from "@montaj/caption-styles/styles/outline-only.json";
import podcastDuo from "@montaj/caption-styles/styles/podcast-duo.json";
import prismSplit from "@montaj/caption-styles/styles/prism-split.json";
import punchPop from "@montaj/caption-styles/styles/punch-pop.json";
import quoteFrame from "@montaj/caption-styles/styles/quote-frame.json";
import softSerif from "@montaj/caption-styles/styles/soft-serif.json";
import spotlightWord from "@montaj/caption-styles/styles/spotlight-word.json";
import strokeHeavy from "@montaj/caption-styles/styles/stroke-heavy.json";
import subtitleClassic from "@montaj/caption-styles/styles/subtitle-classic.json";
import tapeRetro from "@montaj/caption-styles/styles/tape-retro.json";
import typewriterMono from "@montaj/caption-styles/styles/typewriter-mono.json";
import verticalClean from "@montaj/caption-styles/styles/vertical-clean.json";
import whisperThin from "@montaj/caption-styles/styles/whisper-thin.json";
import wordPop from "@montaj/caption-styles/styles/word-pop.json";


/**
 * The import is type-only on purpose: `@montaj/caption-styles`' runtime entry
 * pulls in the catalogue loader, which reads the filesystem. The documents are
 * validated against the schema by the package's own suite and again by
 * `system-styles.test.ts`, in Node, where the loader is welcome.
 */
const DOCUMENTS: readonly unknown[] = [
  arcadePixel,
  boldDrop,
  boxBlock,
  bubbleSoft,
  captionCard,
  duoTone,
  glitchShift,
  gradientSweep,
  highlightMarker,
  hypeBold,
  impactShout,
  karaokeFill,
  liquidGlass,
  minimalLowerThird,
  neonGlow,
  newsTicker,
  outlineOnly,
  podcastDuo,
  prismSplit,
  punchPop,
  quoteFrame,
  softSerif,
  spotlightWord,
  strokeHeavy,
  subtitleClassic,
  tapeRetro,
  typewriterMono,
  verticalClean,
  whisperThin,
  wordPop,
];

/**
 * Every system style, in id order. The cast is what the type-only import buys:
 * a JSON import widens `version: 2` to `number`, so the shape is asserted here
 * and checked for real by `system-styles.test.ts`.
 */
export const SYSTEM_STYLES: readonly StyleDoc[] = DOCUMENTS as readonly StyleDoc[];

/** The catalogue keyed by id, the shape `renderFrame` wants. */
export const SYSTEM_STYLE_MAP: ReadonlyMap<string, StyleDoc> = new Map(
  SYSTEM_STYLES.map((style) => [style.id, style]),
);
