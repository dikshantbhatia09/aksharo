"use client";

/**
 * The project's exports, inside the export dialog (S-02 step 2).
 *
 * F-06 followed one cloud render to its file, but only while the dialog stayed
 * open: closing it called `reset()` (`ExportDialog.tsx`'s `onOpenChange`) and
 * reopening offered a fresh Export button over a render that was still going —
 * F-06's own QA 7. This list is the reattach point, and it also surfaces the
 * audit's orphans: finished MP4s that were never downloaded because nothing
 * ever linked to them.
 *
 * **One source.** S-02 shipped this panel reading two endpoints, because a
 * cloud export had no `exports` row until its completion handler wrote one —
 * so the in-flight half had to come from the render jobs an export is made of.
 * S05 made the row exist from the POST (`rendering`) and gave both completion
 * handlers a `handleFailure` that marks it `failed`, which retires the jobs
 * list entirely: every state this panel can show is now a row's own `status`,
 * and a failed render is a row here instead of a disappearance.
 *
 * It is **one poller**: a single backoff timer over the exports list, started
 * on mount and re-armed only while some row is still non-terminal, because
 * nothing else on this screen can change without a click.
 */

import * as React from "react";

import { defineEndpoint, useApiClient } from "@montaj/api-client";
import type { ApiClient } from "@montaj/api-client";
import { Badge, Button } from "@montaj/ui";

/**
 * `GET /projects/{projectId}/exports` — `exports.controller.ts:165`, returning
 * `ExportListDto` (`exports.dto.ts:214-220`) over `ExportDto`
 * (`exports.dto.ts:199-212`). Declared here rather than in
 * `packages/api-client/src/endpoints.ts` for the reason
 * `apps/web/lib/export/endpoints.ts` gives in its own header — that file is
 * outside this package's boundary — and `operationId` is the generated index's
 * id, so the compiler fails here if the route ever moves.
 */
const exportListEndpoint = defineEndpoint<void, ExportListResponse>({
  method: "GET",
  path: "/projects/{projectId}/exports",
  auth: "bearer",
  operationId: "listProjectExports",
});

/**
 * `GET /exports/{exportId}/download` — `exports.controller.ts:183`, returning
 * `ExportDownloadDto` (`exports.dto.ts:222-228`). Called from the click handler
 * and nowhere else: `url` is a short-TTL R2 presign, and prefetching one per
 * row would put a live credential in the DOM for every export the project has
 * ever produced (F-01's rule for media, applied to delivery).
 */
const exportDownloadEndpoint = defineEndpoint<void, { url: string; expiresAt: string }>({
  method: "GET",
  path: "/exports/{exportId}/download",
  auth: "bearer",
  operationId: "getExportDownloadUrl",
});

/** `ExportDto`, `exports.dto.ts:199-212` — the server's field names, not ours. */
export interface ExportListItem {
  readonly id: string;
  readonly projectId: string;
  /** `pending_browser | rendering | succeeded | failed` (`schema.prisma:1919-1924`). */
  readonly status: string;
  /** `ExportKind`: `mp4 mov srt vtt ass txt docx md` (`schema.prisma:307-316`). */
  readonly kind: string;
  readonly preset?: string | null;
  readonly watermarked: boolean;
  readonly resolution?: string | null;
  readonly durationMs?: number | null;
  readonly sizeBytes?: string | null;
  readonly expiresAt?: string | null;
  readonly downloads: number;
  readonly createdAt: string;
}

/** `ExportListDto`, `exports.dto.ts:214-220`. */
interface ExportListResponse {
  readonly items: readonly ExportListItem[];
  readonly nextCursor: string | null;
}

export interface ExportHistoryProps {
  readonly projectId: string;
  /**
   * Fired whenever "a render is in flight for this project" changes. The dialog
   * uses it to disable its own submit control: F-06 left a reopened dialog
   * inviting a second render of the same project, which is a second credit hold
   * for a file the reader is already waiting for.
   */
  readonly onActiveChange?: (active: boolean) => void;
}

/** Gentle first, then settled — the guide's 5 s → 10 s. */
const POLL_DELAYS_MS = [5_000, 10_000] as const;

/**
 * A row that can still change on its own: a cloud render in flight, or a
 * browser export whose `POST /exports/manifests/{id}/complete` has not landed.
 * Everything else is terminal and only a click can change the screen.
 */
function isRowInFlight(item: ExportListItem): boolean {
  return item.status === "rendering" || item.status === "pending_browser";
}

interface HistorySnapshot {
  readonly loaded: boolean;
  readonly exports: readonly ExportListItem[];
}

const EMPTY: HistorySnapshot = { loaded: false, exports: [] };

/**
 * One tick, degrading to "nothing" on its own: a list that fails must not blank
 * the downloads already on screen — this panel sits under a dialog that has its
 * own job to do.
 */
async function readHistory(client: ApiClient, projectId: string): Promise<HistorySnapshot> {
  const list = await client.call(exportListEndpoint, { params: { projectId } }).catch(() => null);
  return { loaded: true, exports: list?.items ?? [] };
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const RELATIVE_STEPS = [
  { limitMs: 60_000, unit: "second" as const, inMs: 1_000 },
  { limitMs: 3_600_000, unit: "minute" as const, inMs: 60_000 },
  { limitMs: 86_400_000, unit: "hour" as const, inMs: 3_600_000 },
  { limitMs: Number.POSITIVE_INFINITY, unit: "day" as const, inMs: 86_400_000 },
] as const;

/** "3 minutes ago" — an export's age is what tells two of them apart. */
function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const elapsed = Math.max(0, now - then);
  const step = RELATIVE_STEPS.find((candidate) => elapsed < candidate.limitMs);
  if (step === undefined) return iso;
  return RELATIVE.format(-Math.round(elapsed / step.inMs), step.unit);
}

type ChipTone = "neutral" | "warning" | "accepted" | "rejected";

/**
 * Every `ExportStatus` the list can hand back, and nothing else — the row IS
 * the state now (S05). A status this map does not know is treated as in-flight
 * rather than as a finished file: the one thing that must never happen is
 * offering a Download for bytes that are not there.
 */
const CHIPS: Record<string, { readonly chip: string; readonly tone: ChipTone }> = {
  pending_browser: { chip: "In browser", tone: "neutral" },
  rendering: { chip: "Rendering…", tone: "warning" },
  succeeded: { chip: "Succeeded", tone: "accepted" },
  // The row carries no error text, so this says what happened and no more.
  failed: { chip: "Render failed", tone: "rejected" },
};

const UNKNOWN_CHIP = { chip: "Rendering…", tone: "warning" } as const;

interface Row {
  readonly key: string;
  readonly at: string;
  readonly label: string;
  readonly chip: string;
  readonly tone: ChipTone;
  readonly watermarked: boolean;
  /** Present only when there is a file to fetch — a succeeded export. */
  readonly downloadId: string | null;
}

/** `MP4 · reels`, or just `SRT` for a subtitle sidecar (QA 4). */
function describeExport(item: ExportListItem): string {
  const kind = item.kind.toUpperCase();
  const preset = item.preset ?? "";
  return preset === "" ? kind : kind + " · " + preset;
}

function exportRow(item: ExportListItem): Row {
  const succeeded = item.status === "succeeded";
  const { chip, tone } = CHIPS[item.status] ?? UNKNOWN_CHIP;
  return {
    key: "export:" + item.id,
    at: item.createdAt,
    label: describeExport(item),
    chip,
    tone,
    watermarked: item.watermarked,
    downloadId: succeeded ? item.id : null,
  };
}

export function ExportHistory({
  projectId,
  onActiveChange,
}: ExportHistoryProps): React.JSX.Element {
  const client = useApiClient();
  const [snapshot, setSnapshot] = React.useState<HistorySnapshot>(EMPTY);
  const [failedDownload, setFailedDownload] = React.useState<string | null>(null);
  const [busyDownload, setBusyDownload] = React.useState<string | null>(null);

  // One poller. It starts on mount and only re-arms while some row is still
  // non-terminal — with every row settled there is nothing left that can change
  // without a click, so the timer is simply not scheduled again.
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const tick = async (): Promise<void> => {
      const next = await readHistory(client, projectId);
      if (stopped) return;
      setSnapshot(next);
      if (!next.exports.some(isRowInFlight)) return;
      const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)] ?? 10_000;
      attempt += 1;
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    void tick();

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, projectId]);

  // "A render is in flight" is a CLOUD render specifically — a `pending_browser`
  // row is this tab's own export, which the dialog is already busy with and
  // which must not disable the control the way someone else's render does.
  const active = snapshot.exports.some((item) => item.status === "rendering");
  // Through a ref, so an inline arrow prop from the dialog above cannot restart
  // the notification effect on every one of its renders.
  const notify = React.useRef(onActiveChange);
  React.useEffect(() => {
    notify.current = onActiveChange;
  }, [onActiveChange]);
  React.useEffect(() => {
    notify.current?.(active);
  }, [active]);

  const onDownload = React.useCallback(
    async (exportId: string): Promise<void> => {
      setBusyDownload(exportId);
      setFailedDownload(null);
      try {
        // Click time, deliberately: this URL is a short-TTL presign.
        const { url } = await client.call(exportDownloadEndpoint, { params: { exportId } });
        window.open(url, "_blank", "noreferrer");
      } catch {
        setFailedDownload(exportId);
      } finally {
        setBusyDownload(null);
      }
    },
    [client],
  );

  const now = Date.now();
  const rows: readonly Row[] = snapshot.exports
    .map(exportRow)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <section className="mt-6" data-testid="export-history">
      <h3 className="text-fg-2 text-xs font-medium">Previous exports</h3>

      {snapshot.loaded && rows.length === 0 ? (
        <p className="text-fg-2 mt-2 text-xs">No exports yet.</p>
      ) : null}

      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-center gap-2 text-xs"
            data-testid="export-history-row"
          >
            <span className="text-fg-2 shrink-0">{relativeTime(row.at, now)}</span>
            <span className="text-fg-1 truncate">{row.label}</span>
            <Badge tone={row.tone}>{row.chip}</Badge>
            {row.watermarked ? <Badge tone="neutral">Watermarked</Badge> : null}
            {row.downloadId !== null ? (
              <DownloadButton
                exportId={row.downloadId}
                busy={busyDownload === row.downloadId}
                onDownload={onDownload}
              />
            ) : null}
            {row.downloadId !== null && failedDownload === row.downloadId ? (
              <span
                className="text-rejected"
                role="alert"
                data-testid="export-history-download-error"
              >
                No link — try again.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DownloadButton({
  exportId,
  busy,
  onDownload,
}: {
  readonly exportId: string;
  readonly busy: boolean;
  readonly onDownload: (exportId: string) => Promise<void>;
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="ml-auto"
      disabled={busy}
      onClick={() => {
        void onDownload(exportId);
      }}
      data-testid="export-history-download"
    >
      Download
    </Button>
  );
}
