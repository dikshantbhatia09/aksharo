import type { Metadata } from "next";

import { PlanTable } from "@/components/billing/plan-table";

export const metadata: Metadata = { title: "Plans" };

export default function PlansPage(): React.JSX.Element {
  return <PlanTable />;
}
