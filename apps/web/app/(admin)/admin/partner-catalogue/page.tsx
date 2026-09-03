"use client";

import * as React from "react";

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
  const [items, setItems] = React.useState<PartnerGrantRow[]>([]);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Partner catalogue grants</h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-neutral-300">
          <thead>
            <tr className="border-b border-neutral-800 text-neutral-500">
              <th className="py-1 pr-4">Asset</th>
              <th className="py-1 pr-4">Workspace</th>
              <th className="py-1 pr-4">Use context</th>
              <th className="py-1 pr-4">Status</th>
              <th className="py-1 pr-4">Expiry</th>
              <th className="py-1 pr-4">Usage report</th>
              <th className="py-1 pr-4" />
            </tr>
          </thead>
          <tbody>
            {items.map((grant) => (
              <tr key={grant.id} className="border-b border-neutral-900">
                <td className="py-1 pr-4">{grant.providerAssetId ?? grant.id}</td>
                <td className="py-1 pr-4">{grant.workspaceId}</td>
                <td className="py-1 pr-4">{grant.useContext ?? "—"}</td>
                <td className="py-1 pr-4">{grant.status}</td>
                <td className="py-1 pr-4">
                  {grant.expiresAt === null ? "—" : new Date(grant.expiresAt).toLocaleDateString()}
                </td>
                <td className="py-1 pr-4">{grant.reportStatus}</td>
                <td className="py-1 pr-4">
                  {grant.status === "active" && (
                    <button
                      type="button"
                      disabled={revokingId === grant.id}
                      onClick={() => void revoke(grant.id)}
                      className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 disabled:opacity-50"
                    >
                      {revokingId === grant.id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="py-2 text-neutral-500">
                  No grants.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
