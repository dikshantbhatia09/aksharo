"use client";

/** `/projects`' bulk select bar: archive or delete every selected project. */
import * as React from "react";

import { useDeleteProject, useUpdateProject } from "@montaj/api-client";
import { Button, toast } from "@montaj/ui";

import { messageForError } from "@/lib/errors";

export function BulkActionBar({
  selectedIds,
  onClear,
}: {
  selectedIds: ReadonlySet<string>;
  onClear: () => void;
}): React.JSX.Element | null {
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const [busy, setBusy] = React.useState(false);

  if (selectedIds.size === 0) return null;

  const archiveSelected = async (): Promise<void> => {
    setBusy(true);
    const ids = [...selectedIds];
    const results = await Promise.allSettled(
      ids.map((id) => updateProject.mutateAsync({ projectId: id, body: { status: "archived" } })),
    );
    setBusy(false);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      toast.error(`${String(failed)} of ${String(ids.length)} could not be archived.`);
    } else {
      toast.success(`Archived ${String(ids.length)} project${ids.length === 1 ? "" : "s"}.`);
    }
    onClear();
  };

  const deleteSelected = async (): Promise<void> => {
    setBusy(true);
    const ids = [...selectedIds];
    const results = await Promise.allSettled(ids.map((id) => deleteProject.mutateAsync(id)));
    setBusy(false);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected !== undefined) {
      toast.error(`${String(results.filter((r) => r.status === "rejected").length)} of ${String(ids.length)} could not be deleted.`, {
        description: messageForError(rejected.reason),
      });
    } else {
      toast.success(`Deleted ${String(ids.length)} project${ids.length === 1 ? "" : "s"}.`);
    }
    onClear();
  };

  return (
    <div
      className="border-border bg-bg-1 sticky bottom-4 flex items-center gap-3 rounded-md border p-3 shadow-[var(--shadow-panel)]"
      data-testid="bulk-action-bar"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="text-fg-1 text-sm">{selectedIds.size} selected</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          void archiveSelected();
        }}
        data-testid="bulk-archive"
      >
        Archive
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={busy}
        onClick={() => {
          void deleteSelected();
        }}
        data-testid="bulk-delete"
      >
        Delete
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onClear} className="ml-auto">
        Clear
      </Button>
    </div>
  );
}
