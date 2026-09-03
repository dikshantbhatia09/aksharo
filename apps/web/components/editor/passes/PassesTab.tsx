"use client";

import * as React from "react";

import { useApiContext } from "@montaj/api-client";
import type { ItemState, Pass, PassItem } from "@montaj/edg";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProgressBar,
} from "@montaj/ui";

import { ProposalCard } from "./ProposalCard";
import { LocalModeNotice } from "../local-mode-gate";
import { startAutocutPass, type AutocutPreset } from "../../../lib/passes/client";
import {
  decideItems,
  decidedItemIds,
  filterRows,
  itemsAtOrAbove,
  proposedItemIdsOfKind,
  reviewRows,
  summaryDurations,
  type ReviewRow,
} from "../../../lib/passes/decisions";
import { estimateAutocutQuote } from "../../../lib/passes/quote";
import { usePassRunProgress } from "../../../lib/passes/realtime";

import type { EditorStore } from "../../../lib/edg/store";

export interface PassesTabProps {
  readonly projectId: string;
  readonly store: EditorStore;
  readonly passes: readonly Pass[];
  /** For the summary bar's "resulting length"; the project's source media duration. */
  readonly sourceDurationMs: number;
  readonly onPreview?: (item: PassItem, mode: "before" | "after") => void;
  readonly className?: string;
  /**
   * Brief C04b §3: passes run on the worker/cloud, never locally — a local
   * project's caller passes `true` so this tab greys "Run autocut" and shows
   * the "upload to cloud" affordance instead of pretending the run button
   * works. Undefined/`false` behaves exactly as before this WP.
   */
  readonly isLocalProject?: boolean;
  readonly onUploadToCloud?: () => void;
  readonly uploadingToCloud?: boolean;
}

const KIND_OPTIONS: readonly { readonly id: PassItem["kind"] | "all"; readonly label: string }[] = [
  { id: "all", label: "All kinds" },
  { id: "cut", label: "Cuts" },
  { id: "zoom", label: "Zoom" },
  { id: "reframe", label: "Reframe" },
  { id: "sfx", label: "SFX" },
  { id: "music", label: "Music" },
  { id: "title", label: "Title" },
];

const STATUS_OPTIONS: readonly { readonly id: ItemState | "all"; readonly label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "proposed", label: "Proposed" },
  { id: "accepted", label: "Accepted" },
  { id: "rejected", label: "Rejected" },
  { id: "modified", label: "Modified" },
];

/**
 * The Passes tab (B20 §1–4): run an autocut pass, review proposals with
 * keyboard navigation, bulk-accept, and a summary bar driven by
 * `@montaj/timemap` through `summaryDurations`.
 *
 * Decisions are `DecideItems` ops sent through the same `EditorStore` the
 * transcript editor uses (`store.submitOps`) — same debounce, same optimistic
 * UI, same rebase-on-conflict handling A12 built (`docs/CONTRACTS.md` §2).
 */
export function PassesTab({
  projectId,
  store,
  passes,
  sourceDurationMs,
  onPreview,
  className,
  isLocalProject = false,
  onUploadToCloud,
  uploadingToCloud = false,
}: PassesTabProps): React.JSX.Element {
  const { client } = useApiContext();

  const [kind, setKind] = React.useState<PassItem["kind"] | "all">("all");
  const [status, setStatus] = React.useState<ItemState | "all">("all");
  const [minConfidence, setMinConfidence] = React.useState(0);
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const [runDialogOpen, setRunDialogOpen] = React.useState(false);
  const [preset, setPreset] = React.useState<AutocutPreset>("standard");
  const [runningJobId, setRunningJobId] = React.useState<string | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);

  const progress = usePassRunProgress(projectId, runningJobId);

  const allRows = React.useMemo(() => reviewRows(passes), [passes]);
  const rows = React.useMemo(
    () => filterRows(allRows, { kind, status, minConfidence }),
    [allRows, kind, status, minConfidence],
  );
  const summary = React.useMemo(
    () => summaryDurations(allRows, sourceDurationMs),
    [allRows, sourceDurationMs],
  );

  const containerRef = React.useRef<HTMLDivElement>(null);

  const decide = React.useCallback(
    (itemIds: readonly string[], state: ItemState) => {
      if (itemIds.length === 0) return;
      store.submitOps([decideItems(itemIds, state, () => crypto.randomUUID())], {
        label: itemIds.length > 1 ? `${state} ${String(itemIds.length)} items` : state,
      });
    },
    [store],
  );

  const acceptAllAbove = React.useCallback(
    (threshold: number) => decide(itemsAtOrAbove(allRows, threshold), "accepted"),
    [allRows, decide],
  );
  const acceptAllOfKind = React.useCallback(
    (itemKind: PassItem["kind"]) => decide(proposedItemIdsOfKind(allRows, itemKind), "accepted"),
    [allRows, decide],
  );
  const resetDecisions = React.useCallback(
    () => decide(decidedItemIds(allRows), "proposed"),
    [allRows, decide],
  );

  // Keyboard navigation: J/K next/prev, A accept, R reject, Space preview.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (rows.length === 0) return;

      switch (event.key.toLowerCase()) {
        case "j":
          event.preventDefault();
          setFocusedIndex((i) => Math.min(i + 1, rows.length - 1));
          break;
        case "k":
          event.preventDefault();
          setFocusedIndex((i) => Math.max(i - 1, 0));
          break;
        case "a": {
          const row = rows[focusedIndex];
          if (row !== undefined) decide([row.item.itemId], "accepted");
          break;
        }
        case "r": {
          const row = rows[focusedIndex];
          if (row !== undefined) decide([row.item.itemId], "rejected");
          break;
        }
        case " ": {
          const row = rows[focusedIndex];
          if (row !== undefined && onPreview !== undefined) {
            event.preventDefault();
            onPreview(row.item, "after");
          }
          break;
        }
        default:
          break;
      }
    }
    const el = containerRef.current;
    el?.addEventListener("keydown", onKeyDown);
    return () => el?.removeEventListener("keydown", onKeyDown);
  }, [rows, focusedIndex, decide, onPreview]);

  React.useEffect(() => {
    if (focusedIndex >= rows.length) setFocusedIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusedIndex]);

  const runAutocut = React.useCallback(async () => {
    setRunError(null);
    try {
      const response = await client.call(startAutocutPass, {
        params: { projectId },
        body: { preset },
      });
      setRunningJobId(response.jobId);
      setRunDialogOpen(false);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "could not start the pass");
    }
  }, [client, projectId, preset]);

  const estimate = estimateAutocutQuote(sourceDurationMs);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-testid="passes-tab"
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: 12, outline: "none" }}
    >
      {isLocalProject ? (
        <LocalModeNotice
          feature="passes"
          {...(onUploadToCloud === undefined ? {} : { onUploadToCloud })}
          uploading={uploadingToCloud}
        />
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          type="button"
          onClick={() => setRunDialogOpen(true)}
          disabled={isLocalProject}
          data-testid="run-autocut-button"
        >
          Run autocut
        </Button>
        {progress !== null ? (
          <div style={{ flex: 1, maxWidth: 240 }} data-testid="pass-run-progress">
            <ProgressBar value={Math.round((progress.ratio ?? 0) * 100)} label="Autocut pass" />
            <span style={{ fontSize: 12 }}>
              {progress.status === "failed"
                ? `Failed: ${progress.error ?? "unknown error"}`
                : progress.status === "completed"
                  ? "Done"
                  : (progress.message ?? "Running…")}
            </span>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select
          aria-label="Filter by kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as PassItem["kind"] | "all")}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as ItemState | "all")}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          Confidence ≥
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minConfidence}
            aria-label="Minimum confidence"
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
          {Math.round(minConfidence * 100)}%
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => acceptAllAbove(0.8)}
          data-testid="bulk-accept-above-0-8"
        >
          Accept all ≥ 0.8
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => acceptAllOfKind("cut")}
          data-testid="bulk-accept-cuts"
        >
          Accept all cuts
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={resetDecisions}
          data-testid="reset-decisions"
        >
          Reset decisions
        </Button>
      </div>

      <div data-testid="passes-summary-bar" style={{ display: "flex", gap: 16, fontSize: 13 }}>
        <span>
          Removed: <strong>{(summary.removedMs / 1000).toFixed(1)}s</strong>
        </span>
        <span>
          Resulting length: <strong>{(summary.resultingMs / 1000).toFixed(1)}s</strong>
        </span>
        <Badge>{rows.length} shown</Badge>
      </div>

      <div role="list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.length === 0 ? (
          <p data-testid="passes-empty-state">No proposals match these filters.</p>
        ) : (
          rows.map((row: ReviewRow, index: number) => (
            <ProposalCard
              key={row.item.itemId}
              item={row.item}
              focused={index === focusedIndex}
              onDecide={(state) => decide([row.item.itemId], state)}
              onUndo={() => decide([row.item.itemId], "proposed")}
              {...(onPreview === undefined
                ? {}
                : { onPreview: (mode: "before" | "after") => onPreview(row.item, mode) })}
            />
          ))
        )}
      </div>

      <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run autocut</DialogTitle>
          </DialogHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label>
              Preset
              <select value={preset} onChange={(e) => setPreset(e.target.value as AutocutPreset)}>
                <option value="conservative">Conservative</option>
                <option value="standard">Standard</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </label>
            <p data-testid="autocut-quote-estimate">
              Estimated cost: {estimate.credits} credits ({estimate.reason})
            </p>
            {runError !== null ? <p role="alert">{runError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRunDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void runAutocut()}
              data-testid="confirm-run-autocut"
            >
              Confirm & run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
