import type { Metadata } from "next";

import { UsagePanel } from "@/components/billing/usage-panel";

export const metadata: Metadata = { title: "Usage" };

export default function UsagePage(): React.JSX.Element {
  return <UsagePanel />;
}
