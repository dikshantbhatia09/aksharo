"use client";

import * as React from "react";

import { Badge, Button, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface AdminStylePreset {
  id: string;
  key: string;
  name: string;
  published: boolean;
  parity: { assRenderable: boolean; assExportable: boolean; parityScore: number | null };
}

/** Styles catalogue: parity results (read) + publish/unpublish (content/superadmin). */
export default function AdminStylesPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [items, setItems] = React.useState<AdminStylePreset[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reasons, setReasons] = React.useState<Record<string, string>>({});

  const load = React.useCallback(() => {
    adminFetch<AdminStylePreset[]>("/admin/styles")
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  React.useEffect(load, [load]);

  async function togglePublish(style: AdminStylePreset): Promise<void> {
    const reason = reasons[style.id]?.trim() ?? "";
    if (reason.length < 10) {
      setError("A reason (min 10 characters) is required.");
      return;
    }
    try {
      await adminFetch(`/admin/styles/${style.id}/publish`, {
        method: "POST",
        body: { published: !style.published, reason },
      });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Update failed.");
    }
  }

  return (
    <AdminPage>
      <PageHeader
        eyebrow="Content"
        title="Styles catalogue"
        description="Caption styles with their render-parity results. Publishing makes a style available to creators; write a reason of at least 10 characters first."
      />
      {error !== null && <AdminError>{error}</AdminError>}
      {items === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : items.length === 0 ? (
        <AdminEmpty title="No styles in the catalogue" />
      ) : (
        <AdminTable label="Styles catalogue">
          <thead>
            <tr>
              <th className={th}>Key</th>
              <th className={th}>Published</th>
              <th className={`${th} text-right`}>Parity score</th>
              <th className={th}>ASS renderable</th>
              <th className={th}>Reason</th>
              <th className={th}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((style) => (
              <tr key={style.id} className={tr}>
                <td className={`${td} font-mono text-xs text-fg-0`}>{style.key}</td>
                <td className={td}>
                  {style.published ? (
                    <Badge tone="accepted">Published</Badge>
                  ) : (
                    <Badge>Draft</Badge>
                  )}
                </td>
                <td className={`${td} text-right tabular-nums`}>
                  {style.parity.parityScore ?? "—"}
                </td>
                <td className={td}>{style.parity.assRenderable ? "Yes" : "No"}</td>
                <td className={td}>
                  <Input
                    aria-label={`Reason for changing ${style.key}`}
                    value={reasons[style.id] ?? ""}
                    onChange={(e) =>
                      setReasons((prev) => ({ ...prev, [style.id]: e.target.value }))
                    }
                    placeholder="Why this change"
                    className="h-8 min-w-40"
                  />
                </td>
                <td className={`${td} text-right`}>
                  <Button variant="secondary" size="sm" onClick={() => void togglePublish(style)}>
                    {style.published ? "Unpublish" : "Publish"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  );
}
