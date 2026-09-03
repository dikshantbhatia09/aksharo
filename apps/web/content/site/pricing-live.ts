import "server-only";

import { ApiClient, endpoints } from "@montaj/api-client";
import type { PlanCatalogueEntry as ApiPlan } from "@montaj/api-client";

import {
  FALLBACK_PLAN_CATALOGUE,
  type Currency,
  type PlanCatalogueEntry,
  type PlanKey,
} from "./pricing-data";

/**
 * The pricing page's live data. `GET /billing/plans` is public (B01), so no
 * session or access token is needed — a plain `ApiClient` with just a
 * `baseUrl` is enough.
 *
 * Cached with Next.js ISR (`next: { revalidate }` on the injected `fetch`)
 * rather than fetched fresh on every request: the plan catalogue changes on a
 * release cadence, not per visitor, and a 5-minute staleness window is a
 * better trade than adding an API round trip to every pricing page load.
 */
const REVALIDATE_SECONDS = 300;

const REVALIDATING_FETCH: typeof fetch = (input, init) =>
  fetch(input, { ...init, next: { revalidate: REVALIDATE_SECONDS } });

/** Marketing copy (tagline, highlights, CTA, `mostPopular`) has no home in the API — it stays here, keyed by plan. */
const MARKETING_BY_KEY = new Map(
  FALLBACK_PLAN_CATALOGUE.map((plan) => [
    plan.key,
    {
      tagline: plan.tagline,
      mostPopular: plan.mostPopular,
      highlights: plan.highlights,
      ctaLabel: plan.ctaLabel,
    },
  ]),
);

const LADDER_ORDER: readonly PlanKey[] = FALLBACK_PLAN_CATALOGUE.map((plan) => plan.key);

/**
 * The API's `PlanCatalogueEntry` carries prices/seat price as loosely typed
 * `Record<string, Record<string, number>>` (any string key, since it is
 * general-purpose across every billing consumer). This asserts the two
 * currencies the marketing site actually renders exist, keeping the rest of
 * the page working against the same typed `Currency`/`PlanPrice` shapes the
 * static fallback already used — a plan missing a currency the page needs is
 * exactly the kind of API/page mismatch that should fail loudly rather than
 * render `undefined`.
 */
function toTypedPrices(
  raw: Record<string, Record<string, number>>,
): Record<Currency, PlanCatalogueEntry["prices"]["INR"]> {
  const currencies: readonly Currency[] = ["INR", "USD"];
  const result = {} as Record<Currency, PlanCatalogueEntry["prices"]["INR"]>;
  for (const currency of currencies) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const entry = raw[currency];
    if (entry === undefined || typeof entry.month !== "number" || typeof entry.year !== "number") {
      throw new Error(`billing/plans: plan is missing a usable ${currency} price`);
    }
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    result[currency] =
      typeof entry.halfyear === "number"
        ? { month: entry.month, year: entry.year, halfyear: entry.halfyear }
        : { month: entry.month, year: entry.year };
  }
  return result;
}

function toTypedSeatPrice(raw: Record<string, number> | null): Record<Currency, number> | null {
  if (raw === null) return null;
  const inr = raw["INR"];
  const usd = raw["USD"];
  if (typeof inr !== "number" || typeof usd !== "number") return null;
  return { INR: inr, USD: usd };
}

/**
 * Merges B01's numbers onto this file's marketing copy, in ladder order.
 * Exported (and pure) so it is unit-testable without a network call — see
 * `apps/web/app/(site)/(marketing)/_test/site-content.test.ts`.
 */
export function mergeLivePlans(apiPlans: readonly ApiPlan[]): PlanCatalogueEntry[] {
  const byKey = new Map(apiPlans.map((plan) => [plan.key, plan]));
  const merged: PlanCatalogueEntry[] = [];
  for (const key of LADDER_ORDER) {
    const apiPlan = byKey.get(key);
    const marketing = MARKETING_BY_KEY.get(key);
    if (apiPlan === undefined || marketing === undefined) continue;
    merged.push({
      key,
      name: apiPlan.name,
      ...marketing,
      prices: toTypedPrices(apiPlan.prices),
      seatPrice: toTypedSeatPrice(apiPlan.seatPrice),
      creditsPerMonth: Math.round(apiPlan.creditsPerMonthTenths / 10),
    });
  }
  return merged;
}

/**
 * The pricing page's single entry point: the live catalogue when the API
 * answers, `FALLBACK_PLAN_CATALOGUE` (this WP's static, provenance-documented
 * mirror) when it does not. Never throws — a marketing page that 500s because
 * a billing service hiccuped is a worse failure than showing slightly stale
 * prices.
 */
export async function getPlanCatalogue(apiOrigin: string): Promise<{
  plans: readonly PlanCatalogueEntry[];
  source: "live" | "fallback";
}> {
  try {
    const client = new ApiClient({ baseUrl: apiOrigin, fetch: REVALIDATING_FETCH });
    const apiPlans = await client.call(endpoints.billing.listPlans);
    const merged = mergeLivePlans(apiPlans);
    if (merged.length === 0)
      throw new Error("billing/plans returned no plans this page recognises");
    return { plans: merged, source: "live" };
  } catch (error) {
    console.warn(
      "[pricing] GET /billing/plans unreachable, falling back to the static mirror:",
      error instanceof Error ? error.message : error,
    );
    return { plans: FALLBACK_PLAN_CATALOGUE, source: "fallback" };
  }
}
