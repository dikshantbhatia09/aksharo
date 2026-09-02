/**
 * Shared, panel-local shapes for the C06 apply modes. These mirror the frozen EDG v2 shapes
 * from `docs/CONTRACTS.md` §2 (`@montaj/edg`'s `Word`, `Segment`, `PassItem`) and the caption
 * style params from `packages/caption-styles`, but are re-declared here rather than imported:
 * this package bundles with esbuild `--bundle --platform=browser --format=iife` for the UXP
 * panel (see `scripts/build.mjs`) and `src/bridge/protocol.ts` already documents why importing
 * a workspace package that pulls in Node-only transitive code breaks that bundle. `@montaj/edg`
 * itself is pure TS/zod and may be safe to import directly in a later WP; until then this file
 * is the seam apply-mode code depends on, kept structurally identical to CONTRACTS §2 so a
 * caller can pass EDG data through without reshaping it.
 */

export type FrameOf = { readonly startFrames: number; readonly endFrames: number };

/** Mirrors `@montaj/edg`'s `Word` (CONTRACTS §2), reduced to what apply modes need. */
export interface EdgWordLike {
  readonly wid: string;
  readonly t: string;
  readonly startFrames: number;
  readonly endFrames: number;
  readonly deleted?: boolean;
}

/** Mirrors `@montaj/edg`'s `Segment` (CONTRACTS §2), reduced to what apply modes need. */
export interface EdgSegmentLike {
  readonly id: string;
  readonly seq: string;
  readonly startFrames: number;
  readonly endFrames: number;
  readonly styleRef?: string;
  readonly hidden?: boolean;
  readonly speaker?: string;
  readonly words: readonly EdgWordLike[];
}

/** Mirrors `@montaj/edg`'s `PassItem` (CONTRACTS §2), reduced to what apply modes need. */
export interface EdgPassItemLike {
  readonly itemId: string;
  readonly kind: "cut" | "zoom" | "reframe" | "sfx" | "music" | "title";
  readonly startFrames: number;
  readonly endFrames: number;
  readonly state: "proposed" | "accepted" | "rejected" | "modified";
  /** Decoded MKF2 rows (CONTRACTS §2 keyframe payload rule), already unpacked by the caller. */
  readonly keyframes?: readonly {
    readonly tMs: number;
    readonly zoom: number;
    readonly cx: number;
    readonly cy: number;
    readonly ease: "linear" | "inOut";
  }[];
}

/**
 * The appendix param table (C06 brief): the C08b Text+ macro's param names, shared with C06b's
 * MOGRT authoring so style mapping is common. `packages/caption-styles` → these params is
 * C06b/C08b's job; this module only *consumes* the resolved values.
 */
export interface MogrtCaptionParams {
  readonly Text: string;
  readonly Font?: string;
  readonly Size?: number;
  readonly Colour?: string;
  readonly StrokeColour?: string;
  readonly StrokeWidth?: number;
  readonly ShadowOpacity?: number;
  readonly PositionY?: number;
  readonly HighlightColour?: string;
  readonly HighlightStart?: number;
  readonly HighlightEnd?: number;
  readonly StyleId?: string;
}

export const MOGRT_PARAM_ORDER = [
  "Text",
  "Font",
  "Size",
  "Colour",
  "StrokeColour",
  "StrokeWidth",
  "ShadowOpacity",
  "PositionY",
  "HighlightColour",
  "HighlightStart",
  "HighlightEnd",
  "StyleId",
] as const;

export type MogrtParamName = (typeof MOGRT_PARAM_ORDER)[number];

/** One row of an EDG revision fetch, used by the re-sync op (`src/apply/resync.ts`). */
export interface EdgRevisionSnapshot {
  readonly projectId: string;
  readonly revision: number;
  /** Segment ids still present at this revision (deleted/merged-away ids are absent). */
  readonly liveSegmentIds: readonly string[];
}

/** The apply modes a user can select in the panel (brief §Scope 1-5). */
export type ApplyMode =
  "transcript" | "mogrtCaptions" | "alphaOverlay" | "srtToBin" | "cuts" | "zooms" | "audio";

export const APPLY_MODES: readonly ApplyMode[] = [
  "transcript",
  "mogrtCaptions",
  "alphaOverlay",
  "srtToBin",
  "cuts",
  "zooms",
  "audio",
];
