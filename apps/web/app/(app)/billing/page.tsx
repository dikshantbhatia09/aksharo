import type { Metadata } from "next";

import { OverviewPanel } from "@/components/billing/overview-panel";

export const metadata: Metadata = { title: "Subscription" };

export default function BillingOverviewPage(): React.JSX.Element {
  return <OverviewPanel />;
}
