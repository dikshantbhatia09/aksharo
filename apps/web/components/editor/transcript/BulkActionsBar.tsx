"use client";

/**
 * Merge short / split long / auto-resegment (brief §3's bulk actions).
 * "Merge short" and "split long" submit an ordinary op batch through the same
 * queue as any manual edit; auto-resegment opens a params dialog and calls
 * `EditorStore.resegment`, which is server-minted (brief: "auto-resegment →
 * `Resegment` with a params dialog").
 */
import { useState } from "react";

import { cn } from "@/lib/utils";

export interface ResegmentParams {
  readonly maxChars: number;
  readonly maxLines: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly dropFillers: boolean;
}

/** The secondary button the three bulk actions share, so none can drift. */
const BULK_BUTTON =
  "bg-bg-0 border-border text-fg-1 hover:text-fg-0 disabled:text-fg-disabled h-8 rounded-sm border px-2.5 text-xs font-medium transition-colors duration-[160ms] disabled:cursor-not-allowed";

export interface BulkActionsBarProps {
  readonly onMergeShort: () => void;
  readonly onSplitLong: () => void;
  readonly onResegment: (params: ResegmentParams) => void;
  readonly defaultParams: ResegmentParams;
  readonly busy?: boolean;
  readonly className?: string;
}

export function BulkActionsBar({
  onMergeShort,
  onSplitLong,
  onResegment,
  defaultParams,
  busy = false,
  className,
}: BulkActionsBarProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [params, setParams] = useState<ResegmentParams>(defaultParams);

  return (
    <div
      className={cn(
        "border-border bg-bg-2 flex items-center gap-1.5 rounded-sm border p-1.5",
        className,
      )}
      data-testid="bulk-actions-bar"
    >
      <button
        type="button"
        data-testid="bulk-merge-short"
        disabled={busy}
        className={BULK_BUTTON}
        onClick={onMergeShort}
      >
        Merge short
      </button>
      <button
        type="button"
        data-testid="bulk-split-long"
        disabled={busy}
        className={BULK_BUTTON}
        onClick={onSplitLong}
      >
        Split long
      </button>
      <button
        type="button"
        data-testid="bulk-resegment-open"
        disabled={busy}
        className={BULK_BUTTON}
        onClick={() => {
          setParams(defaultParams);
          setDialogOpen(true);
        }}
      >
        Auto-resegment…
      </button>

      {dialogOpen ? (
        <div
          role="dialog"
          aria-label="Auto-resegment"
          data-testid="resegment-dialog"
          className="border-border bg-bg-1 fixed top-1/2 left-1/2 z-50 flex w-80 -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-md border p-4 shadow-xl"
        >
          <span className="text-fg-0 text-sm font-medium">Auto-resegment</span>
          <p className="text-fg-2 text-xs">
            Re-cuts every caption from the live transcript. Manual splits, merges and hidden
            captions on the current captions are replaced.
          </p>
          {(
            [
              ["maxChars", "Max characters a line", 8, 60],
              ["maxLines", "Max lines a caption", 1, 3],
              ["minMs", "Min caption length (ms)", 200, 3000],
              ["maxMs", "Max caption length (ms)", 1000, 12000],
            ] as const
          ).map(([key, label, min, max]) => (
            <label
              key={key}
              className="text-fg-1 flex min-h-8 items-center justify-between gap-3 text-sm"
            >
              {label}
              <input
                type="number"
                min={min}
                max={max}
                // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
                value={params[key]}
                data-testid={`resegment-${key}`}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value))
                    setParams((current) => ({ ...current, [key]: value }));
                }}
                className="border-border bg-bg-0 text-fg-0 h-8 w-20 rounded-sm border px-2 text-right text-xs tabular-nums"
              />
            </label>
          ))}
          <label className="text-fg-1 flex min-h-8 items-center justify-between gap-3 text-sm">
            Drop filler words
            <input
              type="checkbox"
              checked={params.dropFillers}
              data-testid="resegment-drop-fillers"
              onChange={(event) => {
                setParams((current) => ({ ...current, dropFillers: event.target.checked }));
              }}
              className="panel-switch"
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="resegment-cancel"
              className="bg-bg-2 border-border text-fg-1 hover:text-fg-0 h-8 rounded-sm border px-3 text-sm font-medium transition-colors duration-[160ms]"
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="resegment-confirm"
              className="bg-lime-500 hover:bg-lime-600 text-on-accent flex h-8 items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors duration-[160ms]"
              onClick={() => {
                setDialogOpen(false);
                onResegment(params);
              }}
            >
              Resegment
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
