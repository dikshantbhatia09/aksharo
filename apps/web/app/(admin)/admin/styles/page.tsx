"use client";

import * as React from "react";

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
  const [items, setItems] = React.useState<AdminStylePreset[]>([]);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Styles catalogue</h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <table className="w-full text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Key</th>
            <th className="py-1 pr-4">Published</th>
            <th className="py-1 pr-4">Parity score</th>
            <th className="py-1 pr-4">ASS renderable</th>
            <th className="py-1 pr-4">Reason</th>
            <th className="py-1 pr-4" />
          </tr>
        </thead>
        <tbody>
          {items.map((style) => (
            <tr key={style.id} className="border-t border-neutral-800">
              <td className="py-1.5 pr-4">{style.key}</td>
              <td className="py-1.5 pr-4">{style.published ? "yes" : "no"}</td>
              <td className="py-1.5 pr-4">{style.parity.parityScore ?? "—"}</td>
              <td className="py-1.5 pr-4">{style.parity.assRenderable ? "yes" : "no"}</td>
              <td className="py-1.5 pr-4">
                <input
                  value={reasons[style.id] ?? ""}
                  onChange={(e) => setReasons((prev) => ({ ...prev, [style.id]: e.target.value }))}
                  className="w-40 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="py-1.5 pr-4">
                <button
                  type="button"
                  onClick={() => void togglePublish(style)}
                  className="rounded bg-neutral-800 px-2 py-1"
                >
                  {style.published ? "Unpublish" : "Publish"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
