import { AffiliateView } from "./affiliate-view";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";

export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("affiliates");
  return { title: "Refer & earn" };
}

export default function AffiliatePage(): React.JSX.Element {
  assertServerSurfaceEnabled("affiliates");
  return <AffiliateView />;
}
