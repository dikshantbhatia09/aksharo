import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";

/**
 * B13 scope §3: "separate layout (no product chrome)". No `<AppShell>` here
 * — the studio sidebar, command palette and product nav never render on
 * `/admin/**`.
 */
export default function AdminLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <AdminShell>{children}</AdminShell>;
}
