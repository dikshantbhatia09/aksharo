"use client";

import * as React from "react";

import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface AdminSupportStatus {
  available: boolean;
  message: string;
}

/** Stub — B12's support-ticket module had not merged when this WP landed. */
export default function AdminSupportPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [status, setStatus] = React.useState<AdminSupportStatus | null>(null);

  React.useEffect(() => {
    adminFetch<AdminSupportStatus>("/admin/support/status")
      .then(setStatus)
      .catch(() => undefined);
  }, [adminFetch]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Support</h1>
      <p className="text-sm text-neutral-400">{status?.message ?? "Loading…"}</p>
    </div>
  );
}
