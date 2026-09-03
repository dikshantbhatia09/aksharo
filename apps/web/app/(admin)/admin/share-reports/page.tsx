"use client";

import * as React from "react";

import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface ShareReport {
  id: string;
  shareLinkId: string;
  category: string;
  dueAt: string;
}

/** `GET /admin/share-reports` + `POST .../:id/resolve` (ops/content/superadmin). */
export default function AdminShareReportsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [items, setItems] = React.useState<ShareReport[]>([]);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    adminFetch<ShareReport[]>("/admin/share-reports")
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch]);

  React.useEffect(load, [load]);

  async function resolve(id: string, action: "take_down" | "dismiss" | "warned"): Promise<void> {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const note = notes[id]?.trim() ?? "";
    if (note.length < 10) {
      setError("A note (min 10 characters) is required to resolve a report.");
      return;
    }
    try {
      await adminFetch(`/admin/share-reports/${id}/resolve`, {
        method: "POST",
        body: { action, note },
      });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Resolve failed.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Share-link reports</h1>
      <p className="text-xs text-neutral-500">
        Take-down is wired; notifying the reporter/workspace is not (no template yet).
      </p>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-neutral-300">
        {items.map((report) => (
          <li key={report.id} className="rounded border border-neutral-800 p-3">
            <p>
              {report.category} — due {new Date(report.dueAt).toLocaleString()}
            </p>
            <div className="mt-2 flex gap-2">
              <input
                value={notes[report.id] ?? ""}
                onChange={(e) => setNotes((prev) => ({ ...prev, [report.id]: e.target.value }))}
                placeholder="resolution note"
                className="w-56 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              />
              <button
                type="button"
                onClick={() => void resolve(report.id, "take_down")}
                className="rounded bg-neutral-800 px-2 py-1"
              >
                Take down
              </button>
              <button
                type="button"
                onClick={() => void resolve(report.id, "dismiss")}
                className="rounded bg-neutral-800 px-2 py-1"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
        {items.length === 0 && <p className="text-neutral-500">No unresolved reports.</p>}
      </ul>
    </div>
  );
}
