import { BRAND } from "@montaj/config";

import { PricingContent } from "./_components/pricing-content";

import type { Metadata } from "next";

/**
 * A thin server wrapper: `generateMetadata`/`metadata` can only be exported
 * from a Server Component, and the pricing page's currency and billing-interval
 * toggles need client state — so the interactive body lives in
 * `_components/pricing-content.tsx` and this file only supplies the metadata
 * Next's App Router requires a server component for.
 */
export const metadata: Metadata = {
  title: "Pricing",
  description:
    "One credit pool for web, desktop and every plugin. INR by default with a USD toggle, a free clean export on signup, and a full breakdown of credits, burn rates and offers.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: `Pricing — ${BRAND.name}`,
    description: "One credit pool, every surface. INR by default, USD toggle.",
    url: "/pricing",
    type: "website",
  },
};

export default function PricingPage(): React.JSX.Element {
  return <PricingContent />;
}
