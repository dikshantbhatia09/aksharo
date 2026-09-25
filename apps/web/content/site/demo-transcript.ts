/**
 * The bundled sample for the home page's live browser demo (A24 brief: "a live
 * demo that transcribes a bundled 15-second Hinglish sample entirely in the
 * browser using a bundled mock transcript (no ASR call)").
 *
 * This is a hand-authored mock transcript, not a real ASR result and not backed
 * by a real 15-second video clip — no such clip was available to this work
 * package (reported as a deviation). The words carry the same shape
 * `@montaj/render-core`'s `layoutSegment` expects (`RenderWord`: `wid`, `t`,
 * `s`, `e`, `sp`, CONTRACTS §2's `Word` minus the transcript-only fields), timed
 * across a 15 s cue so the demo drives the *real* renderer
 * (`@montaj/render-canvaskit`) end to end, the same way
 * `packages/render-core/src/styles/preview.ts` drives the style gallery tiles.
 *
 * Script is Roman ("Hinglish (Roman)" is the product's own default quick-pick,
 * 08-ux-design-system.md §Home), so the demo needs only the bundled Latin font
 * subset — no Devanagari fetch on the marketing homepage's critical path.
 */

import { PICKABLE_STYLE_IDS } from "@montaj/caption-styles/browser";
import type { WordScript } from "@montaj/render-core";

export interface DemoWord {
  readonly wid: string;
  readonly t: string;
  readonly s: number;
  readonly e: number;
  readonly sp: string;
}

export const DEMO_SCRIPT: WordScript = "latin";

export const DEMO_DURATION_MS = 15_000;

/**
 * "Bhai ye caption dekho kitna clean lag raha hai. Ek click mein styled, cut,
 * zoom — sab kuch ready. Apni language mein, apne andaaz mein. Try karo, free
 * mein."
 *
 * ("Look how clean this caption looks. One click and it's styled, cut, zoomed —
 * everything's ready. In your language, in your own style. Try it, free.")
 */
export const DEMO_WORDS: readonly DemoWord[] = [
  { wid: "demo:0", t: "Bhai", s: 0, e: 600, sp: "sp1" },
  { wid: "demo:1", t: "ye", s: 650, e: 900, sp: "sp1" },
  { wid: "demo:2", t: "caption", s: 950, e: 1500, sp: "sp1" },
  { wid: "demo:3", t: "dekho", s: 1550, e: 1950, sp: "sp1" },
  { wid: "demo:4", t: "kitna", s: 2000, e: 2400, sp: "sp1" },
  { wid: "demo:5", t: "clean", s: 2450, e: 2900, sp: "sp1" },
  { wid: "demo:6", t: "lag", s: 2950, e: 3200, sp: "sp1" },
  { wid: "demo:7", t: "raha", s: 3250, e: 3600, sp: "sp1" },
  { wid: "demo:8", t: "hai.", s: 3650, e: 3950, sp: "sp1" },
  { wid: "demo:9", t: "Ek", s: 4500, e: 4800, sp: "sp1" },
  { wid: "demo:10", t: "click", s: 4850, e: 5300, sp: "sp1" },
  { wid: "demo:11", t: "mein", s: 5350, e: 5600, sp: "sp1" },
  { wid: "demo:12", t: "styled,", s: 5650, e: 6200, sp: "sp1" },
  { wid: "demo:13", t: "cut,", s: 6250, e: 6600, sp: "sp1" },
  { wid: "demo:14", t: "zoom,", s: 6650, e: 7000, sp: "sp1" },
  { wid: "demo:15", t: "sab", s: 7050, e: 7300, sp: "sp1" },
  { wid: "demo:16", t: "kuch", s: 7350, e: 7650, sp: "sp1" },
  { wid: "demo:17", t: "ready.", s: 7700, e: 8200, sp: "sp1" },
  { wid: "demo:18", t: "Apni", s: 8800, e: 9150, sp: "sp1" },
  { wid: "demo:19", t: "language", s: 9200, e: 9700, sp: "sp1" },
  { wid: "demo:20", t: "mein,", s: 9750, e: 10100, sp: "sp1" },
  { wid: "demo:21", t: "apne", s: 10150, e: 10500, sp: "sp1" },
  { wid: "demo:22", t: "andaaz", s: 10550, e: 11000, sp: "sp1" },
  { wid: "demo:23", t: "mein.", s: 11050, e: 11400, sp: "sp1" },
  { wid: "demo:24", t: "Try", s: 12000, e: 12350, sp: "sp1" },
  { wid: "demo:25", t: "karo,", s: 12400, e: 12800, sp: "sp1" },
  { wid: "demo:26", t: "free", s: 12850, e: 13200, sp: "sp1" },
  { wid: "demo:27", t: "mein.", s: 13250, e: 13700, sp: "sp1" },
];

/** Plain-text fallback for screen readers and for the `<noscript>` path. */
export const DEMO_PLAIN_TEXT =
  "Bhai ye caption dekho kitna clean lag raha hai. Ek click mein styled, cut, zoom, sab kuch ready. Apni language mein, apne andaaz mein. Try karo, free mein.";

export const DEMO_SEGMENT = {
  id: "demo:segment",
  startMs: 0,
  endMs: DEMO_DURATION_MS,
} as const;

/**
 * The demo's switcher: the pickable styles (`PICKABLE_STYLE_IDS`), so the home
 * page never shows a style the product no longer offers.
 */
export const DEMO_STYLE_IDS: readonly string[] = PICKABLE_STYLE_IDS;
