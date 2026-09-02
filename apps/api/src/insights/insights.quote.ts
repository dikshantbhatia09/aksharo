import { TENTHS_PER_CREDIT, formatCredits } from "@montaj/config";
import type { InsightKind } from "@montaj/prompts";

/**
 * What one `ai.llm` run costs (brief §4: "credits (per config: chapters 2,
 * summary 1, hooks 2 per run)").
 *
 * ### A note on `packages/config`'s `BURN_RATES.chaptersSummaryHook`
 *
 * `packages/config/src/credits.ts` already has a `chaptersSummaryHook` burn
 * rate, but it is a single flat "2 credits per job" for all three kinds
 * (`basis: "job"`, `ratePerUnitTenths: 20`), which conflicts with this
 * brief's per-kind pricing (chapters 2, summary **1**, hooks 2). Per the WP
 * brief template ("if the brief and the architecture docs conflict, stop and
 * report the conflict rather than choosing"), that conflict is reported in
 * this work package's final message rather than silently resolved here.
 * `packages/config` is outside this brief's file boundary
 * (`packages/prompts/**`, `apps/worker-ai/worker_ai/llm/**`,
 * `apps/api/src/insights/**`, `apps/api/prisma/**`), so it is not edited by
 * this change; the per-kind prices the brief asks for are implemented locally
 * here, still denominated the same way (`CreditOperation`, tenths of a
 * credit) so a future reconciliation is a one-line change.
 */
export const INSIGHT_KIND_TENTHS: Readonly<Record<InsightKind, number>> = {
  chapters: 2 * TENTHS_PER_CREDIT,
  summary: 1 * TENTHS_PER_CREDIT,
  hooks: 2 * TENTHS_PER_CREDIT,
};

export interface InsightQuote {
  readonly kind: InsightKind;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

export function quoteInsight(kind: InsightKind): InsightQuote {
  const tenths = INSIGHT_KIND_TENTHS[kind];
  return {
    kind,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.llm · ${kind}`,
  };
}

/** Total tenths for a batch of kinds requested in one call. */
export function quoteInsightBatch(kinds: readonly InsightKind[]): number {
  return kinds.reduce((total, kind) => total + INSIGHT_KIND_TENTHS[kind], 0);
}
