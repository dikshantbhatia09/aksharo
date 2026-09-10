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
      className="border-border bg-bg-1 fixed top-16 left-1/2 z-40 flex w-96 -translate-x-1/2 flex-col gap-3 rounded-md border p-4 shadow-xl"
    >
      <p className="text-fg-0 text-sm font-medium">
        Someone else edited this {conflict.target === "word" ? "word" : "caption"} at the same time.
      </p>
      <p className="text-fg-2 text-xs">Choose which version to keep — both are shown below.</p>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="conflict-choose-mine"
          className="border-border bg-bg-0 text-fg-0 hover:bg-bg-2 rounded-sm border px-3 py-2 text-left text-sm transition-colors duration-[160ms]"
          onClick={() => {
            onResolve(conflict.opId, "mine");
          }}
        >
          <span className="text-fg-2 text-2xs block font-medium tracking-wide uppercase">
            Yours
          </span>
          {conflict.yours}
        </button>
        <button
          type="button"
          data-testid="conflict-choose-theirs"
          className="border-border bg-bg-0 text-fg-0 hover:bg-bg-2 rounded-sm border px-3 py-2 text-left text-sm transition-colors duration-[160ms]"
          onClick={() => {
            onResolve(conflict.opId, "theirs");
          }}
        >
          <span className="text-fg-2 text-2xs block font-medium tracking-wide uppercase">
            Theirs
          </span>
          {conflict.theirs}
        </button>
      </div>

      {conflicts.length > 1 ? (
        <p className="text-fg-2 text-xs tabular-nums">{conflicts.length - 1} more waiting.</p>
      ) : null}

      <button
        type="button"
        data-testid="conflict-dismiss"
        className="text-fg-2 hover:text-fg-0 self-end rounded-sm text-xs transition-colors duration-[160ms]"
        onClick={() => {
          onDismiss(conflict.opId);
        }}
      >
        Keep theirs and dismiss
      </button>
    </div>
  );
}
