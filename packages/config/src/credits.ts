/**
 * Credit burn rates, typed (03-architecture/04 §Credits).
 *
 * Units, per docs/CONTRACTS.md §0: credits are integer TENTHS of a credit
 * (`*Tenths`), so 1.0 credit === 10 tenths. Media time is milliseconds (`*Ms`).
 * Every job is billed on time rounded UP to 0.1 of a minute ("deciminutes").
 *
 * 1 credit === transcribing 1 minute of media in the cloud.
 */

/** Milliseconds in the smallest billable unit: 0.1 minute. */
export const BILLING_QUANTUM_MS = 6_000;

/** Tenths of a credit in one whole credit. */
export const TENTHS_PER_CREDIT = 10;

/** What a rate is multiplied by. */
export type CreditBasis =
  /** Duration of the input media. */
  | "mediaMinute"
  /** Duration of the rendered output. */
  | "outputMinute"
  /** Duration of the source timeline fed to a pass. */
  | "sourceMinute"
  /** Duration of the finished (post-cut) timeline. */
  | "finishedMinute"
  /** Flat charge, independent of duration. */
  | "job";

/** Quality/engine tier for the passes that offer both. */
export type EngineTier = "flash" | "pro";

/** Plan ladder from 03-architecture/04 §Plans. */
export type PlanTier = "free" | "starter" | "creator" | "studio" | "agency";

export type CreditOperation =
  | "transcription"
  | "translation"
  | "audioClean"
  | "cloudRender"
  | "autocutPass"
  | "reframeZoomPass"
  | "sfxMusicPass"
  | "textFxPass"
  | "promptedEdit"
  | "insightsChapters"
  | "insightsSummary"
  | "insightsHooks";

export interface BurnRate {
  readonly operation: CreditOperation;
  readonly basis: CreditBasis;
  /** Tenths of a credit per basis unit (per whole minute, or per job when basis is "job"). */
  readonly ratePerUnitTenths: number;
  /** Pro-engine rate, where the operation offers two tiers. */
  readonly proRatePerUnitTenths?: number;
  /** Rate when the work runs on the user's own machine (0 for every local path today). */
  readonly localRatePerUnitTenths?: number;
  /** Multiply by the number of target languages. */
  readonly perTargetLanguage?: boolean;
  /** Basis used for the worst-case hold when it differs from `basis`. */
  readonly holdBasis?: CreditBasis;
  /** Lowest plan that may run the operation; `null` means every plan. */
  readonly minimumPlan: PlanTier | null;
  readonly note: string;
}

export const BURN_RATES = {
  transcription: {
    operation: "transcription",
    basis: "mediaMinute",
    ratePerUnitTenths: 10,
    localRatePerUnitTenths: 0,
    minimumPlan: null,
    note: "Any language, diarisation included. Local desktop transcription is free (Starter+).",
  },
  translation: {
    operation: "translation",
    basis: "mediaMinute",
    ratePerUnitTenths: 5,
    perTargetLanguage: true,
    minimumPlan: "starter",
    note: "Per target language. English on Starter+, all languages on Creator+.",
  },
  audioClean: {
    operation: "audioClean",
    basis: "mediaMinute",
    ratePerUnitTenths: 10,
    localRatePerUnitTenths: 0,
    minimumPlan: "creator",
    note: "48 kHz path. Local is free.",
  },
  cloudRender: {
    operation: "cloudRender",
    basis: "outputMinute",
    ratePerUnitTenths: 5,
    localRatePerUnitTenths: 0,
    minimumPlan: null,
    note: "Interim rate, re-derived after the render benchmark. Browser-native render is free.",
  },
  autocutPass: {
    operation: "autocutPass",
    basis: "sourceMinute",
    ratePerUnitTenths: 10,
    proRatePerUnitTenths: 20,
    minimumPlan: "creator",
    note: "Pro engine is Studio/Agency only.",
  },
  reframeZoomPass: {
    operation: "reframeZoomPass",
    basis: "sourceMinute",
    ratePerUnitTenths: 10,
    proRatePerUnitTenths: 30,
    minimumPlan: "creator",
    note: "Scene detection, subject tracking and cue detection.",
  },
  sfxMusicPass: {
    operation: "sfxMusicPass",
    basis: "finishedMinute",
    ratePerUnitTenths: 10,
    minimumPlan: "studio",
    note: "Library entitlement is carried at plan level, not per credit.",
  },
  textFxPass: {
    operation: "textFxPass",
    basis: "finishedMinute",
    ratePerUnitTenths: 10,
    minimumPlan: "creator",
    note:
      "Key-phrase title extraction (D06 §6). Billed per finished minute (D07 " +
      "principle: passes that read the post-cut timeline settle on it), one " +
      "LLM call regardless of phrase count.",
  },
  promptedEdit: {
    operation: "promptedEdit",
    basis: "finishedMinute",
    ratePerUnitTenths: 30,
    proRatePerUnitTenths: 80,
    holdBasis: "sourceMinute",
    minimumPlan: "creator",
    note: "Held on source minutes at enqueue, settled on finished minutes.",
  },
  insightsChapters: {
    operation: "insightsChapters",
    basis: "job",
    ratePerUnitTenths: 20,
    minimumPlan: "creator",
    note: "Chapters insight, 2 credits per job (03-architecture/04 §Credits).",
  },
  insightsSummary: {
    operation: "insightsSummary",
    basis: "job",
    ratePerUnitTenths: 10,
    minimumPlan: "creator",
    note: "Summary insight, 1 credit per job (03-architecture/04 §Credits).",
  },
  insightsHooks: {
    operation: "insightsHooks",
    basis: "job",
    ratePerUnitTenths: 20,
    minimumPlan: "creator",
    note: "Hooks insight, 2 credits per job (03-architecture/04 §Credits).",
  },
} as const satisfies Record<CreditOperation, BurnRate>;

export type BurnRateTable = typeof BURN_RATES;

export const CREDIT_OPERATIONS = Object.keys(BURN_RATES) as readonly CreditOperation[];

/**
 * Duration in billable 0.1-minute units, always rounded up.
 * A non-empty job always costs at least one quantum.
 */
export function deciMinutes(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(
      `durationMs must be a finite, non-negative number, received ${durationMs}`,
    );
  }
  return Math.max(1, Math.ceil(durationMs / BILLING_QUANTUM_MS));
}

export interface CreditCostInput {
  readonly operation: CreditOperation;
  /** Duration on the operation's own basis. Ignored when the basis is "job". */
  readonly durationMs?: number;
  readonly tier?: EngineTier;
  /** Number of target languages for `translation`; defaults to 1. */
  readonly targetLanguages?: number;
  /** Work runs on the user's machine, so the local rate applies. */
  readonly local?: boolean;
}

/**
 * Cost of one job in tenths of a credit: always a non-negative integer.
 * This is the amount to `settle`; use {@link worstCaseHoldTenths} for the amount
 * to `reserve` at enqueue (CONTRACTS §4).
 */
export function creditCostTenths(input: CreditCostInput): number {
  // Widen from the `as const` literal to the interface so the optional fields
  // that only some rows carry are visible.
  const rate: BurnRate = BURN_RATES[input.operation];
  const tier: EngineTier = input.tier ?? "flash";

  let perUnitTenths: number;
  if (input.local === true) {
    perUnitTenths = rate.localRatePerUnitTenths ?? rate.ratePerUnitTenths;
  } else if (tier === "pro") {
    perUnitTenths = rate.proRatePerUnitTenths ?? rate.ratePerUnitTenths;
  } else {
    perUnitTenths = rate.ratePerUnitTenths;
  }

  if (perUnitTenths === 0) return 0;

  const languages = rate.perTargetLanguage === true ? Math.max(1, input.targetLanguages ?? 1) : 1;

  if (rate.basis === "job") {
    return perUnitTenths * languages;
  }

  // `units` are deciminutes; `perUnitTenths` is per whole minute, hence the /10.
  const units = deciMinutes(input.durationMs ?? 0);
  return Math.ceil((units * perUnitTenths * languages) / 10);
}

/**
 * Worst-case reservation for an operation whose settled basis is shorter than its
 * input (today only `promptedEdit`, which is held on source minutes).
 */
export function worstCaseHoldTenths(
  input: CreditCostInput & { readonly sourceDurationMs?: number },
): number {
  const rate: BurnRate = BURN_RATES[input.operation];
  if (rate.holdBasis === undefined) return creditCostTenths(input);
  return creditCostTenths({
    ...input,
    durationMs: input.sourceDurationMs ?? input.durationMs ?? 0,
  });
}

/** Presentation helper: 25 tenths -> "2.5". Never used for arithmetic. */
export function formatCredits(tenths: number): string {
  return (tenths / TENTHS_PER_CREDIT).toFixed(1).replace(/\.0$/, "");
}

/**
 * A quote for one job: what to reserve at enqueue and what to settle on
 * completion, both computed from the same `@montaj/config` burn rate.
 *
 * This is the shape B02's brief calls `quote(operation, media minutes)` — a
 * producer (A11 transcripts/post-processing, A21 exports, A22 translation) that
 * probed a media duration hands it straight to {@link quote} instead of
 * re-deriving `creditCostTenths`/`worstCaseHoldTenths` math (and the ms/minute
 * conversion) by hand, which is how A08's `media.constants.ts` warns a hard-coded
 * worst case can drift from `BURN_RATES`.
 */
export interface CreditQuote {
  readonly operation: CreditOperation;
  /** Reserve this many tenths at enqueue (CONTRACTS §4 `reserve.worstCaseTenths`). */
  readonly holdTenths: number;
  /** Settle this many tenths once the job's real output duration is known. */
  readonly costTenths: number;
}

export interface QuoteOptions {
  readonly tier?: EngineTier;
  /** Number of target languages, for `translation`; defaults to 1. */
  readonly targetLanguages?: number;
  /** The work runs on the user's own machine, so the local rate applies. */
  readonly local?: boolean;
  /**
   * Source media minutes, for an operation whose hold basis differs from its
   * settle basis (today only `promptedEdit`, held on source minutes). Defaults to
   * `mediaMinutes` when omitted, so most callers never pass it.
   */
  readonly sourceMediaMinutes?: number;
}

/**
 * Quote one job on `@montaj/config`'s burn rates, in minutes rather than
 * milliseconds — the unit a producer already has after probing media or reading
 * an EDG's `durationMs / 60_000`.
 *
 * `mediaMinutes` is the operation's own basis (media minutes for transcription
 * and translation, output minutes for `cloudRender`, source minutes for the edit
 * passes, finished minutes for `sfxMusicPass`/`promptedEdit` — see
 * {@link BurnRate.basis}), never negative; a caller with a duration in
 * milliseconds divides by 60,000 first. `insightsChapters`/`insightsSummary`/
 * `insightsHooks` are `"job"` basis and ignore the minutes argument entirely.
 */
export function quote(
  operation: CreditOperation,
  mediaMinutes: number,
  options: QuoteOptions = {},
): CreditQuote {
  if (!Number.isFinite(mediaMinutes) || mediaMinutes < 0) {
    throw new RangeError(
      `mediaMinutes must be a finite, non-negative number, received ${mediaMinutes}`,
    );
  }
  // `Math.round`, not the bare product: a caller that already had milliseconds
  // (a probed duration, a worker's `outputMs`) and divided by 60,000 to get here
  // hands back a value whose re-multiplication can land a few ULPs past an exact
  // `BILLING_QUANTUM_MS` boundary (measured: ~3% of exact-quantum durations
  // round-tripped through `ms/60_000` and back land a hair over the boundary).
  // `deciMinutes`'s `Math.ceil` treats that hair as a whole extra quantum, which
  // is a real over-charge, not a rounding nicety — `Math.round` back to the
  // nearest millisecond removes the float noise before it can cross one.
  const durationMs = Math.round(mediaMinutes * 60_000);
  const costInput: CreditCostInput = {
    operation,
    durationMs,
    ...(options.tier === undefined ? {} : { tier: options.tier }),
    ...(options.targetLanguages === undefined ? {} : { targetLanguages: options.targetLanguages }),
    ...(options.local === undefined ? {} : { local: options.local }),
  };

  return {
    operation,
    costTenths: creditCostTenths(costInput),
    holdTenths: worstCaseHoldTenths({
      ...costInput,
      ...(options.sourceMediaMinutes === undefined
        ? {}
        : { sourceDurationMs: Math.round(options.sourceMediaMinutes * 60_000) }),
    }),
  };
}
