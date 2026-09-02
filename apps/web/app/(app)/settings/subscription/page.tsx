import { SubscriptionView } from "./subscription-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Subscription" };

export default function SubscriptionSettingsPage(): React.JSX.Element {
  return <SubscriptionView />;
}
