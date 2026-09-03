/**
 * A client-side estimate of what running a prompted-edit plan will cost,
 * shown in the plan preview sheet before `run()` is called.
 *
 * Mirrors `apps/api/src/passes/passes.quote.ts`'s `quotePromptedEdit` (same
 * `@montaj/config` `promptedEdit` burn rate: held on source minutes, settled
 * on finished minutes) the same way `estimateAutocutQuote` mirrors
 * `quoteAutocut` — that module lives in `apps/api`, outside this work
 * package's file boundary. The plan's own `holdTenths` (from
 * `POST /prompted-edits`) is the authoritative figure; this estimate only
 * lets the engine toggle re-price itself instantly, client-side, before a
 * second request.
 */
import { BILLING_QUANTUM_MS, deciMinutes, formatCredits, worstCaseHoldTenths } from "@montaj/config";

import type { PromptedEditEngine } from "./prompted-edits-client";

export interface PromptedEditQuoteEstimate {
  readonly holdTenths: number;
  readonly holdCredits: string;
  readonly reason: string;
}

/**
 * `sourceDurationMs`/`finishedDurationMs` -- before a plan has run, the finished
 * (post-cut) duration is unknown, so the preview sheet passes the source
 * duration for both, matching the server's own `plan()`-time estimate.
 */
export function estimatePromptedEditQuote(
  sourceDurationMs: number,
  finishedDurationMs: number,
  engine: PromptedEditEngine,
): PromptedEditQuoteEstimate {
  const holdTenths = worstCaseHoldTenths({
    operation: "promptedEdit",
    durationMs: finishedDurationMs,
    sourceDurationMs,
    tier: engine,
  });
  const units = deciMinutes(sourceDurationMs);
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;
  return {
    holdTenths,
    holdCredits: formatCredits(holdTenths),
    reason: `ai.pass (prompted, ${engine}) · held on ${minutes.toFixed(1)} source minutes`,
  };
}

