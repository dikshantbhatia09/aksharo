import { AffiliateView } from "./affiliate-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Refer & earn" };

export default function AffiliatePage(): React.JSX.Element {
  return <AffiliateView />;
}
