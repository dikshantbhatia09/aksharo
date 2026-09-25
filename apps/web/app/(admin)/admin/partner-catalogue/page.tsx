"use client";

import * as React from "react";

import { Badge, Button, PageHeader } from "@montaj/ui";

import {
  AdminError,
  AdminLoading,
  AdminPage,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface PartnerGrantRow {
  id: string;
  workspaceId: string;
  providerAssetId: string | null;
  useContext: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  reportStatus: "reported" | "unreported" | "no_usage";
}

/** D04b2 scope §5 — every partner-catalogue grant, with revoke (`AdminPartnerCatalogueController`). */
export default function AdminPartnerCatalogueGrantsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [items, setItems] = React.useState<PartnerGrantRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    adminFetch<PartnerGrantRow[]>("/admin/partner-catalogue/grants")
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function revoke(id: string): Promise<void> {
    setRevokingId(id);
    setError(null);
    try {
      await adminFetch(`/admin/partner-catalogue/grants/${id}/revoke`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <AdminPage>
      <PageHeader
        eyebrow="Content"
        title="Partner catalogue grants"
        description="Every grant a workspace holds on a partner asset, with its usage-report status. Revoke ends an active grant."
      />
      {error !== null && <AdminError>{error}</AdminError>}
      {items === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : (
        <AdminTable label="Partner catalogue grants">
          <thead>
            <tr>
              <th className={th}>Asset</th>
              <th className={th}>Workspace</th>
              <th className={th}>Use context</th>
              <th className={th}>Status</th>
              <th className={th}>Expiry</th>
              <th className={th}>Usage report</th>
              <th className={th}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((grant) => (
              <tr key={grant.id} className={tr}>
                <td className={`${td} font-mono text-xs text-fg-0`}>
                  {grant.providerAssetId ?? grant.id}
                </td>
                <td className={`${td} font-mono text-xs`}>{grant.workspaceId}</td>
                <td className={td}>{grant.useContext ?? "—"}</td>
                <td className={td}>
                  <Badge tone={grant.status === "active" ? "accepted" : "neutral"}>
                    {grant.status}
                  </Badge>
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  {grant.expiresAt === null ? "—" : new Date(grant.expiresAt).toLocaleDateString()}
                </td>
                <td className={td}>{grant.reportStatus}</td>
                <td className={`${td} text-right`}>
                  {grant.status === "active" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={revokingId === grant.id}
                      onClick={() => void revoke(grant.id)}
                    >
                      {revokingId === grant.id ? "Revoking…" : "Revoke"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className={`${td} text-fg-2`}>
                  No grants.
                </td>
              </tr>
            )}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  );
}
