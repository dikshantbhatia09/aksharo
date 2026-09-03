import type { BurnRate, CreditOperation } from "@montaj/config";
import { BURN_RATES, creditCostTenths, formatCredits } from "@montaj/config";
import type { InsightKind } from "@montaj/prompts";

/**
 * What one `ai.llm` run costs (brief §4: "credits (per config: chapters 2,
 * summary 1, hooks 2 per run)").
 *
 * Per the 2026-09-02 ruling, `packages/config`'s `BURN_RATES` is the single
 * source for these rates — its old flat `chaptersSummaryHook` (2 credits/job
 * for every kind) was replaced with per-kind operations
 * (`insightsChapters`/`insightsSummary`/`insightsHooks`), so this module no
 * longer carries its own local price table; it only maps an {@link InsightKind}
 * onto the matching `CreditOperation` and reads the rate through
 * `creditCostTenths`.
 */
const INSIGHT_KIND_OPERATION: Readonly<Record<InsightKind, CreditOperation>> = {
  chapters: "insightsChapters",
  summary: "insightsSummary",
  hooks: "insightsHooks",
};

/** Tenths of a credit per insight kind, read from `@montaj/config`'s `BURN_RATES`. */
export const INSIGHT_KIND_TENTHS: Readonly<Record<InsightKind, number>> = {
  chapters: creditCostTenths({ operation: "insightsChapters" }),
  summary: creditCostTenths({ operation: "insightsSummary" }),
  hooks: creditCostTenths({ operation: "insightsHooks" }),
};

export interface InsightQuote {
  readonly kind: InsightKind;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

function tenthsFor(kind: InsightKind): number {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return INSIGHT_KIND_TENTHS[kind];
}

export function quoteInsight(kind: InsightKind): InsightQuote {
  const tenths = tenthsFor(kind);
  return {
    kind,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.llm · ${kind}`,
  };
}

/** Total tenths for a batch of kinds requested in one call. */
export function quoteInsightBatch(kinds: readonly InsightKind[]): number {
  return kinds.reduce((total, kind) => total + tenthsFor(kind), 0);
}

/** The `@montaj/config` burn rate backing an insight kind, for diagnostics/tests. */
export function burnRateFor(kind: InsightKind): BurnRate {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return BURN_RATES[INSIGHT_KIND_OPERATION[kind]];
}
