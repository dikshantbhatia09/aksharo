import { BRAND } from "@montaj/config";

import { PricingContent } from "./_components/pricing-content";

import type { Metadata } from "next";

import { getPlanCatalogue } from "@/content/site/pricing-live";
import { readRuntimeConfig } from "@/lib/runtime-config";

/**
 * A thin server wrapper: `generateMetadata`/`metadata` can only be exported
 * from a Server Component, and the pricing page's currency and billing-interval
 * toggles need client state — so the interactive body lives in
 * `_components/pricing-content.tsx`. This file also owns the one server-side
 * concern the client component cannot: fetching the plan catalogue
 * (`content/site/pricing-live.ts` — live `GET /billing/plans` with ISR,
 * falling back to the static mirror when the API is unreachable) before
 * rendering, so the client component always receives finished data as props.
 */
export const metadata: Metadata = {
  title: "Pricing",
  description:
    "One unified credit pool for your web studio. INR by default with a USD toggle, a free clean export on signup, and a full breakdown of credits, burn rates and offers.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: `Pricing — ${BRAND.name}`,
    description: "One unified credit pool. INR by default, USD toggle.",
    url: "/pricing",
    type: "website",
  },
};

export default async function PricingPage(): Promise<React.JSX.Element> {
  const { apiOrigin } = readRuntimeConfig();
  const { plans, source } = await getPlanCatalogue(apiOrigin);
  return <PricingContent plans={plans} source={source} />;
}
