"use client";

/**
 * The same-word/same-caption conflict chooser (brief §2: "surfaces same-word
 * conflicts as an inline chooser"). Never a silent pick: both texts are shown
 * and the user decides, exactly as `edg/conflict`'s body
 * (`{latestRevision, opsSince, conflicts}`) is designed to let a client do.
 */
import type { TextConflict } from "@/lib/edg/client";

export interface ConflictDialogProps {
  readonly conflicts: readonly TextConflict[];
  readonly onResolve: (opId: string, choice: "mine" | "theirs") => void;
  readonly onDismiss: (opId: string) => void;
}

export function ConflictDialog({
  conflicts,
  onResolve,
  onDismiss,
}: ConflictDialogProps): React.JSX.Element | null {
  if (conflicts.length === 0) return null;
  const conflict = conflicts[0];
  if (conflict === undefined) return null;

  return (
    <div
      role="alertdialog"
      aria-label="Someone else edited this at the same time"
      data-testid="conflict-dialog"
      className="border-amber-400/40 bg-bg-1 fixed top-16 left-1/2 z-40 flex w-96 -translate-x-1/2 flex-col gap-3 rounded-lg border p-4 shadow-xl"
    >
      <p className="text-sm font-medium">
        Someone else edited this {conflict.target === "word" ? "word" : "caption"} at the same time.
      </p>
      <p className="text-fg-3 text-xs">Choose which version to keep — both are shown below.</p>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="conflict-choose-mine"
          className="rounded-md border border-white/10 px-3 py-2 text-left text-sm hover:bg-white/5"
          onClick={() => {
            onResolve(conflict.opId, "mine");
          }}
        >
          <span className="text-fg-3 block text-xs">Yours</span>
          {conflict.yours}
        </button>
        <button
          type="button"
          data-testid="conflict-choose-theirs"
          className="rounded-md border border-white/10 px-3 py-2 text-left text-sm hover:bg-white/5"
          onClick={() => {
            onResolve(conflict.opId, "theirs");
          }}
        >
          <span className="text-fg-3 block text-xs">Theirs</span>
          {conflict.theirs}
        </button>
      </div>

      {conflicts.length > 1 ? (
        <p className="text-fg-3 text-xs">{conflicts.length - 1} more waiting.</p>
      ) : null}

      <button
        type="button"
        data-testid="conflict-dismiss"
        className="text-fg-3 self-end text-xs hover:underline"
        onClick={() => {
          onDismiss(conflict.opId);
        }}
      >
        Keep theirs and dismiss
      </button>
    </div>
  );
}
