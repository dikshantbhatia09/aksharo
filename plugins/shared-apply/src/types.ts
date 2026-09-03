/**
 * Host-neutral shapes for the D09 apply-plan builder.
 *
 * These mirror `docs/CONTRACTS.md` §2's `PassItem`/`ItemKind` and the
 * "Amendment 2026-09-03 (D06 / D04a / D05)" block (`sfx`/`music`/`title` payload
 * fields), reduced to what plan-building needs — the same pattern
 * `plugins/premiere-uxp/src/apply/types.ts` already uses for C06 (re-declared
 * rather than importing `@montaj/edg`, whose Node-only transitive deps would
 * break that plugin's browser bundle). This package has no such constraint
 * (it depends on nothing but `zod`), so it is safe for `plugins/premiere-uxp`
 * to import directly — see that package's `package.json`, which now lists
 * `@montaj/shared-apply` as a plain dependency, same as `@montaj/caption-styles`.
 */

export type MotionPreset = "pop" | "slide-up" | "typewriter" | "underline" | "count-up" | "fade";
export type TitleIntent = "title" | "stat" | "quote" | "hook";
export type LayoutCandidate = "top-third" | "upper-left" | "upper-right" | "centre";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** CONTRACTS §2 amendment: `TitlePayload` additive fields — there is no `text_fx` kind, every
 * text-fx item rides the existing `title` `ItemKind` (orchestrator addendum 2026-09-03 after D06). */
export interface TitlePayload {
  readonly text: string;
  readonly intent?: TitleIntent;
  readonly motionPreset?: MotionPreset;
  readonly anchorWordIds?: readonly string[];
  readonly layoutHint?: { readonly candidate: LayoutCandidate; readonly safeArea: Rect };
  readonly styleRef?: string;
}

export interface DuckSpec {
  readonly depthDb: number;
  readonly attackMs: number;
  readonly releaseMs: number;
}

/** CONTRACTS §2 amendment: `SfxPayload`. */
export interface SfxPayload {
  readonly assetId: string;
  readonly packId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly duck: DuckSpec | null;
  readonly licenceSnapshot: LicenceSnapshot;
  readonly cueReason?: string;
}

/** CONTRACTS §2 amendment: `MusicPayload`. */
export interface MusicPayload {
  readonly assetId: string;
  readonly packId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly gainDb: number;
  readonly loopPolicy: "none" | "loop" | "trim";
  readonly bedDuck: DuckSpec | null;
  readonly licenceSnapshot: LicenceSnapshot;
  readonly mood?: string;
  readonly bpm?: number;
}

/** The D43/D44 fields this WP's client-side re-check reads (brief: "licence predicate
 * re-checked client-side: `allowsRawFileDelivery` and `licenceSnapshot.surface` include
 * `panel`"). Everything else in a real `licenceSnapshot` is opaque to this package. */
export interface LicenceSnapshot {
  readonly allowsRawFileDelivery: boolean;
  readonly surface: readonly string[];
}

export type ItemKind = "cut" | "zoom" | "reframe" | "sfx" | "music" | "title";
export type ItemState = "proposed" | "accepted" | "rejected" | "modified";

export interface DecodedKeyframe {
  readonly tMs: number;
  readonly zoom: number;
  readonly cx: number;
  readonly cy: number;
  readonly ease: "linear" | "inOut";
}

/** Mirrors CONTRACTS §2's `PassItem`, narrowed to `payload` shapes this package understands. */
export interface ApplyPlanItem {
  readonly itemId: string;
  readonly passId: string;
  readonly kind: ItemKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly state: ItemState;
  readonly payload: SfxPayload | MusicPayload | TitlePayload | Record<string, unknown>;
  /** Decoded MKF2 rows (CONTRACTS §2 keyframe payload rule), already unpacked by the caller —
   * this package never decodes MKF2 itself, matching `plugins/premiere-uxp/src/apply/types.ts`. */
  readonly keyframes?: readonly DecodedKeyframe[];
}

export type ApplyPlanItemInput = ApplyPlanItem;

// --------------------------------------------------------------------------------------------
// Host-neutral operations. Every op is JSON-serialisable (no functions, no host handles) so the
// same plan can cross the TS/Python boundary as plain data — see the package README for why this
// WP picked "JSON exchange" over a duplicate Python port of the *building* logic (only the
// *shapes* below are ported to Python, in `plugins/resolve/aksharo_core_app/apply_plan.py`, so
// the two plugins can consume one already-computed plan without re-deriving it twice, which is
// the actual drift risk a full logic port would create).
// --------------------------------------------------------------------------------------------

export interface DeleteRangeOp {
  readonly op: "deleteRange";
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface MotionKeyframeOp {
  readonly op: "motionKeyframes";
  readonly itemId: string;
  readonly keyframes: readonly DecodedKeyframe[];
}

export type AudioClipKind = "sfx" | "music";

export interface AudioFade {
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
}

export interface AudioClipOp {
  readonly op: "audioClip";
  readonly itemId: string;
  readonly kind: AudioClipKind;
  readonly assetId: string;
  readonly packId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly gainDb: number;
  readonly fade: AudioFade;
  readonly duck: DuckSpec | null;
  readonly loopPolicy: "none" | "loop" | "trim" | null;
  readonly trackName: string;
}

/** A refused sfx/music item (D43 "cloud render only"): never becomes an `AudioClipOp`, reported
 * separately so the panel can render the refusal badge instead of silently dropping the item. */
export interface AudioClipRefusal {
  readonly itemId: string;
  readonly kind: AudioClipKind;
  readonly assetId: string;
  readonly reasons: readonly LicenceDenyReason[];
  readonly message: string;
}

export interface TitleParamOp {
  readonly op: "title";
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly motionPreset: MotionPreset;
  readonly intent: TitleIntent;
  readonly layoutCandidate: LayoutCandidate;
  /** Resolved param table (mogrt param names for Premiere, Text+ macro input names for
   * Resolve — both are the same 14-name frozen table plus `MotionPreset`, see `motionPresets.ts`). */
  readonly params: Readonly<Record<string, string | number>>;
  /** True when the target host cannot express `motionPreset` at all (neither plugin's title
   * MOGRT/macro publishes it yet) and the caller must fall back to a static overlay clip. */
  readonly requiresOverlayFallback: boolean;
}

export type ApplyOp = DeleteRangeOp | MotionKeyframeOp | AudioClipOp | TitleParamOp;

export interface ApplyPlan {
  readonly ops: readonly ApplyOp[];
  readonly audioRefusals: readonly AudioClipRefusal[];
}

export type LicenceDenyReason = "not-owned" | "surface-not-allowed";
