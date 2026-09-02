"use client";

import * as React from "react";

import { useRuntimeConfig } from "@/components/providers";
import { readAdminSession } from "@/lib/admin/admin-session";
import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface PendingAffiliate {
  id: string;
  userId: string;
  code: string;
  status: string;
  country: string;
}

/** Pending applications (any admin role) + links to FY TDS export/Form 16A (finance/superadmin). */
export default function AdminAffiliatesPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const config = useRuntimeConfig();
  const [items, setItems] = React.useState<PendingAffiliate[]>([]);
  const [fyLabel, setFyLabel] = React.useState("2026-27");
  const [error, setError] = React.useState<string | null>(null);

  async function downloadCsv(): Promise<void> {
    const session = readAdminSession();
    if (session === null) {
      setError("Step up again.");
      return;
    }
    // The API requires a bearer header a plain <a href> cannot send — fetch
    // it as the admin, then hand the browser the file via a blob URL.
    const response = await fetch(`${config.apiOrigin}/admin/affiliates/tds/${fyLabel}/export.csv`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!response.ok) {
      setError(`Export failed (${String(response.status)}).`);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `affiliate-tds-${fyLabel}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  React.useEffect(() => {
    adminFetch<PendingAffiliate[]>("/admin/affiliates/pending")
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Affiliates</h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <h2 className="text-sm font-semibold text-neutral-200">Pending applications</h2>
      <ul className="text-sm text-neutral-300">
        {items.map((a) => (
          <li key={a.id}>
            {a.code} ({a.country})
          </li>
        ))}
        {items.length === 0 && <p className="text-neutral-500">None pending.</p>}
      </ul>
      <h2 className="mt-2 text-sm font-semibold text-neutral-200">TDS (finance/superadmin)</h2>
      <div className="flex items-center gap-2 text-sm">
        <input
          value={fyLabel}
          onChange={(e) => setFyLabel(e.target.value)}
          className="w-28 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
        />
        <button
          type="button"
          onClick={() => void downloadCsv()}
          className="rounded bg-neutral-800 px-3 py-1.5 text-neutral-100"
        >
          Export FY totals (CSV)
        </button>
      </div>
    </div>
  );
}
