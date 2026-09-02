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
 *
 * The MOGRT param table is different: it is not a workspace package, it is this same plugin's
 * own `mogrt/params.ts` (plain TS/zod, no Node-only code, already imported directly by
 * `src/styles/mogrt-map.ts` and proven to bundle fine), so `MOGRT_PARAM_ORDER`/`MogrtParamName`
 * below import it instead of re-declaring it a second time. C06 originally hardcoded its own
 * copy of the appendix table here because C06b (MOGRT authoring) had not landed yet when C06
 * was built; now that it has, `mogrt/params.ts` is the single source of truth (14 params,
 * append-only — see that file's doc comment for why `BoxFill`/`BoxOpacity` were added after the
 * original 12).
 */

import { MOGRT_PARAM_NAMES, type MogrtParamName } from "../../mogrt/params.js";

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
 * The frozen MOGRT param table (`mogrt/params.ts`, C06b): the C08b Text+ macro's param names,
 * shared with C06b's MOGRT authoring so style mapping is common. `packages/caption-styles` →
 * these params is C06b/C08b's job; this module only *consumes* the resolved values.
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
  readonly BoxFill?: string;
  readonly BoxOpacity?: number;
}

/** Re-exported from `mogrt/params.ts` — see the module doc comment above. */
export const MOGRT_PARAM_ORDER = MOGRT_PARAM_NAMES;

export type { MogrtParamName };

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
