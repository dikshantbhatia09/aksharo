import type { Metadata } from "next";

import { InvoicesPanel } from "@/components/billing/invoices-panel";

export const metadata: Metadata = { title: "Invoices" };

export default function InvoicesPage(): React.JSX.Element {
  return <InvoicesPanel />;
}
