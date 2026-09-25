"use client";

import * as React from "react";

import { Button, ConfirmAction, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  adminCard,
} from "@/components/admin/admin-ui";
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
  const [items, setItems] = React.useState<ShareReport[] | null>(null);
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
    <AdminPage>
      <PageHeader
        eyebrow="Content"
        title="Share-link reports"
        description="Resolving a report notifies the reporter (when they left contact details) and the workspace owner. Write a note of at least 10 characters first."
      />
      {error !== null && <AdminError>{error}</AdminError>}
      {items === null ? (
        error === null ? (
          <AdminLoading />
        ) : null
      ) : items.length === 0 ? (
        <AdminEmpty title="No unresolved reports" />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((report) => (
            <li key={report.id} className={`${adminCard} flex flex-col gap-3`}>
              <div>
                <p className="text-sm font-medium text-fg-0">{report.category}</p>
                <p className="text-xs text-fg-2">
                  Due {new Date(report.dueAt).toLocaleString()} · link{" "}
                  <span className="font-mono">{report.shareLinkId}</span>
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  aria-label={`Resolution note for the ${report.category} report`}
                  value={notes[report.id] ?? ""}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [report.id]: e.target.value }))}
                  placeholder="Resolution note"
                  className="h-8 sm:max-w-80"
                />
                <div className="flex gap-2">
                  <ConfirmAction
                    title="Take this shared video down?"
                    description="The share link stops working for everyone and the report is closed as taken down."
                    confirmLabel="Take it down"
                    confirmTestId={`confirm-take-down-${report.id}`}
                    onConfirm={() => resolve(report.id, "take_down")}
                    trigger={
                      <Button variant="danger" size="sm">
                        Take down
                      </Button>
                    }
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void resolve(report.id, "dismiss")}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminPage>
  );
}
