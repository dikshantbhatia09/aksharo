"use client";

import * as React from "react";

import { Button, Field, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSection,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
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
  const [items, setItems] = React.useState<PendingAffiliate[] | null>(null);
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
    <AdminPage>
      <PageHeader
        eyebrow="Money"
        title="Affiliates"
        description="Applications waiting for a decision, and the financial-year TDS totals finance files."
      />
      {error !== null && <AdminError>{error}</AdminError>}

      <AdminSection title="Pending applications" bare>
        {items === null ? (
          error === null ? (
            <AdminLoading />
          ) : null
        ) : items.length === 0 ? (
          <AdminEmpty title="None pending" />
        ) : (
          <AdminTable label="Pending affiliate applications" className="max-w-2xl">
            <thead>
              <tr>
                <th className={th}>Code</th>
                <th className={th}>Country</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className={tr}>
                  <td className={`${td} font-mono text-xs text-fg-0`}>{a.code}</td>
                  <td className={td}>{a.country}</td>
                  <td className={td}>{a.status}</td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>

      <AdminSection
        title="TDS export"
        description="Finance and superadmin only. Downloads the year's totals as a CSV file."
        className="max-w-2xl"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void downloadCsv();
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <Field label="Financial year" htmlFor="tds-fy" hint="For example 2026-27">
            <Input
              id="tds-fy"
              value={fyLabel}
              onChange={(e) => setFyLabel(e.target.value)}
              className="w-32 font-mono"
            />
          </Field>
          <Button type="submit" variant="primary" className="sm:mb-5">
            Export FY totals (CSV)
          </Button>
        </form>
      </AdminSection>
    </AdminPage>
  );
}
