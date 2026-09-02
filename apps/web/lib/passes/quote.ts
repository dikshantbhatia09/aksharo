/**
 * A client-side estimate of what an autocut pass will cost, shown in the
 * Passes tab's "Run autocut" confirm dialog before the request is sent.
 *
 * Mirrors `apps/api/src/passes/passes.quote.ts`'s `quoteAutocut` (same
 * `@montaj/config` burn rate, same rounding), rather than importing it: that
 * module lives in `apps/api`, outside this work package's file boundary, and
 * NestJS-adjacent server modules are not meant to bundle into the browser.
 * The API's own `POST /projects/{id}/passes/autocut` response carries the
 * authoritative `quote` it actually charged — this estimate exists only to
 * let a reviewer decide *before* spending anything; if the two ever
 * disagree, the server's number in the response is the one that happened.
 */
import { BILLING_QUANTUM_MS, creditCostTenths, deciMinutes, formatCredits } from "@montaj/config";

export interface AutocutQuoteEstimate {
  readonly durationMs: number;
  readonly deciMinutes: number;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

export function estimateAutocutQuote(durationMs: number): AutocutQuoteEstimate {
  const units = deciMinutes(durationMs);
  const tenths = creditCostTenths({ operation: "autocutPass", durationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.pass (autocut) · ${minutes.toFixed(1)} source minutes`,
  };
}
