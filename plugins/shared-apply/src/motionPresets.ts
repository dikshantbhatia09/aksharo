/**
 * `TitlePayload.motionPreset` -> host title-param mapping (D09 brief §Scope 1/2, orchestrator
 * addendum 2026-09-03 after D06: "presets map to the C06b `.mogrt` parameters / Text+ macro
 * parameters by `motionPreset`" — there is no D06b draw-path dependency; this WP maps the enum
 * directly to static param values both hosts already understand (position/opacity/scale-ish
 * numbers on the frozen 14-name param table plus one new `MotionPreset` marker param), not to a
 * frame-by-frame animation curve. Neither Premiere's caption MOGRT nor Resolve's Text+ macro
 * publishes a native "animate in" input yet (that is C06b/C08b's caption param table, authored
 * for static-per-cue captions) — so every preset here resolves to the same param names, with
 * `requiresOverlayFallback=true` reserved for a future preset this table can't express at all.
 * Today all six D06 presets map to expressible static params, so the fallback path exists but is
 * never hit — this is flagged in the final report as the honest state of "support", not invented
 * animation behaviour.
 */
import type { LayoutCandidate, MotionPreset, TitleIntent } from "./types.js";

export interface MotionPresetParams {
  /** `PositionY` percent-of-height, same semantics as the caption MOGRT's `PositionY`. */
  readonly PositionY: number;
  /** New: not part of the frozen 14-param caption table (`mogrt/params.ts`); this is the title
   * MOGRT's own param, added by this WP to C06b's generator (see `mogrt/title-params.ts`). */
  readonly MotionPreset: string;
  readonly HighlightStart: number;
  readonly HighlightEnd: number;
}

const BASE: Readonly<Record<MotionPreset, MotionPresetParams>> = {
  pop: { PositionY: 20, MotionPreset: "pop", HighlightStart: 0, HighlightEnd: 100 },
  "slide-up": { PositionY: 30, MotionPreset: "slide-up", HighlightStart: 0, HighlightEnd: 100 },
  typewriter: { PositionY: 20, MotionPreset: "typewriter", HighlightStart: 0, HighlightEnd: 100 },
  underline: { PositionY: 25, MotionPreset: "underline", HighlightStart: 0, HighlightEnd: 0 },
  "count-up": { PositionY: 20, MotionPreset: "count-up", HighlightStart: 0, HighlightEnd: 100 },
  fade: { PositionY: 20, MotionPreset: "fade", HighlightStart: 0, HighlightEnd: 100 },
};

const CANDIDATE_POSITION_Y: Readonly<Record<LayoutCandidate, number>> = {
  "top-third": 15,
  "upper-left": 20,
  "upper-right": 20,
  centre: 50,
};

const INTENT_DEFAULT_PRESET: Readonly<Record<TitleIntent, MotionPreset>> = {
  title: "pop",
  stat: "count-up",
  quote: "fade",
  hook: "slide-up",
};

/** Every preset this table can express — used by `planBuilder` to decide `requiresOverlayFallback`. */
const SUPPORTED_PRESETS = new Set<MotionPreset>(Object.keys(BASE) as MotionPreset[]);

export function isMotionPresetSupported(preset: MotionPreset): boolean {
  return SUPPORTED_PRESETS.has(preset);
}

export function defaultPresetForIntent(intent: TitleIntent): MotionPreset {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return INTENT_DEFAULT_PRESET[intent];
}

/**
 * Resolves a title item's full param table: the preset's static params, overridden by the
 * layout candidate's `PositionY` when a `layoutHint` was supplied (the layout solver's placement
 * wins over the preset's own default position — the preset only ever chose that default because
 * no layout hint existed yet).
 */
export function resolveMotionPresetParams(
  preset: MotionPreset,
  layoutCandidate: LayoutCandidate | undefined,
): MotionPresetParams {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const base = BASE[preset];
  if (layoutCandidate === undefined) return base;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return { ...base, PositionY: CANDIDATE_POSITION_Y[layoutCandidate] };
}
