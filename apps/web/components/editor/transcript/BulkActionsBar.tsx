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
    <div className={cn("flex items-center gap-1.5", className)} data-testid="bulk-actions-bar">
      <button
        type="button"
        data-testid="bulk-merge-short"
        disabled={busy}
        className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40"
        onClick={onMergeShort}
      >
        Merge short
      </button>
      <button
        type="button"
        data-testid="bulk-split-long"
        disabled={busy}
        className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40"
        onClick={onSplitLong}
      >
        Split long
      </button>
      <button
        type="button"
        data-testid="bulk-resegment-open"
        disabled={busy}
        className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-xs hover:bg-white/10 disabled:opacity-40"
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
          className="border-white/10 bg-bg-1 fixed top-1/2 left-1/2 z-50 flex w-80 -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-lg border p-4 shadow-xl"
        >
          <span className="text-sm font-medium">Auto-resegment</span>
          <p className="text-fg-3 text-xs">
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
            <label key={key} className="flex items-center justify-between gap-2 text-xs">
              {label}
              <input
                type="number"
                min={min}
                max={max}
                value={params[key]}
                data-testid={`resegment-${key}`}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value))
                    setParams((current) => ({ ...current, [key]: value }));
                }}
                className="w-20 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-right"
              />
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={params.dropFillers}
              data-testid="resegment-drop-fillers"
              onChange={(event) => {
                setParams((current) => ({ ...current, dropFillers: event.target.checked }));
              }}
            />
            Drop filler words
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="resegment-cancel"
              className="text-fg-3 px-3 py-1.5 text-sm hover:underline"
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="resegment-confirm"
              className="rounded-md bg-lime-400 px-3 py-1.5 text-sm font-medium text-black"
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
