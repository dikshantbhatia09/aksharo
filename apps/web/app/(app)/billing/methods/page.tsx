import type { Metadata } from "next";

import { PaymentMethodsPanel } from "@/components/billing/payment-methods-panel";

export const metadata: Metadata = { title: "Payment methods" };

export default function PaymentMethodsPage(): React.JSX.Element {
  return <PaymentMethodsPanel />;
}
