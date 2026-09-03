/**
 * Flash/Pro engine tiers for prompted edits (D07 §2, 09-ai-pipeline §6):
 *
 * > Flash = fast models (VAD-only cut, 540p tracking, cached picks); Pro =
 * > full pipeline (LLM re-ranked cuts, full-res tracking, larger ASR re-pass).
 *
 * This module owns *which pass params an engine tier maps to* — the same
 * split `credits.ts` makes between "the rate" (owned here) and "which
 * duration" (owned by the caller): `apps/api/src/passes/passes.service.ts`
 * and `apps/worker-ai/worker_ai/passes/**` both read `ENGINE_PRESETS` rather
 * than hard-coding a resolution or ASR model string per pass kind, so a tier
 * definition changes in exactly one place.
 *
 * `EngineTier` itself is `credits.ts`'s own type — re-exported here for
 * convenience, not redefined.
 */
import type { EngineTier } from "./credits.js";

export type { EngineTier } from "./credits.js";

/** How the autocut pass finds cut candidates. */
export type AutocutStrategy = "vad_only" | "llm_reranked";

/** Frame source the zoom/reframe passes sample for tracking. */
export type TrackingResolution = "540p" | "full_res";

export interface AutocutEngineParams {
  readonly strategy: AutocutStrategy;
  /** Flash reuses a previous VAD pass's picks for this media when available. */
  readonly cachedPicks: boolean;
}

export interface TrackingEngineParams {
  readonly resolution: TrackingResolution;
}

export interface AsrEngineParams {
  /** `null` on Flash: no re-pass, the original transcription stands. */
  readonly repassModel: string | null;
}

export interface EnginePassParams {
  readonly tier: EngineTier;
  readonly autocut: AutocutEngineParams;
  readonly tracking: TrackingEngineParams;
  readonly asr: AsrEngineParams;
}

/**
 * The two engine presets. Frozen shape (an `ENGINE_PRESETS[tier]` result is
 * sent to `apps/worker-ai` verbatim inside an `ai.pass`/`ai.llm` job payload,
 * CONTRACTS §3), so a new field here is additive-only.
 */
export const ENGINE_PRESETS: Record<EngineTier, EnginePassParams> = {
  flash: {
    tier: "flash",
    autocut: { strategy: "vad_only", cachedPicks: true },
    tracking: { resolution: "540p" },
    asr: { repassModel: null },
  },
  pro: {
    tier: "pro",
    autocut: { strategy: "llm_reranked", cachedPicks: false },
    tracking: { resolution: "full_res" },
    asr: { repassModel: "asr-repass-large" },
  },
} as const satisfies Record<EngineTier, EnginePassParams>;

/** `ENGINE_PRESETS[tier]`, defaulting an omitted tier to `"flash"`. */
export function engineParamsFor(tier: EngineTier | undefined): EnginePassParams {
  return ENGINE_PRESETS[tier ?? "flash"];
}
