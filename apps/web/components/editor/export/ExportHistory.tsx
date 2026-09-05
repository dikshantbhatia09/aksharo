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
 * **Why two sources.** The obvious implementation — poll
 * `GET /projects/{id}/exports` and read each row's `status` — cannot show a
 * running render, because a cloud export has no row until it finishes. The
 * database says so in its own words (`schema.prisma:1913-1916`, the
 * `ExportStatus` doc comment: *"a cloud export's row is written once, by the
 * job completion handler, already `succeeded` or `failed`"*), the enum has no
 * `queued`/`running` member to hold, and both write sites confirm it
 * (`render-completion.handler.ts:147` and `:263`). So the in-flight half comes
 * from the render jobs an export is made of, and the durable half — the thing
 * you can download — from the exports list.
 *
 * It is still **one poller**: a single backoff timer that reads both endpoints
 * on the same tick, started on mount and stopped the moment no render job is in
 * flight, because nothing else on this screen can change without one.
 */

import * as React from "react";

import { defineEndpoint, endpoints, useApiClient } from "@montaj/api-client";
import type { ApiClient, JobSummary } from "@montaj/api-client";
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
  /** `pending_browser | succeeded | failed` (`schema.prisma:1917-1921`). */
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

/** Newest-first, and only ever a handful are in flight. */
const JOB_PAGE_SIZE = 20;

/** The render queues an export is made of (`exports.service.ts:124-125`). */
const RENDER_JOB_TYPES = new Set(["render.video", "render.subtitle"]);

/** A job that can still change on its own. `JobStatus`, `types.ts:476`. */
function isJobInFlight(job: JobSummary): boolean {
  return job.status === "queued" || job.status === "running";
}

interface HistorySnapshot {
  readonly loaded: boolean;
  readonly exports: readonly ExportListItem[];
  readonly activeJobs: readonly JobSummary[];
}

const EMPTY: HistorySnapshot = { loaded: false, exports: [], activeJobs: [] };

/**
 * One tick: both halves, in parallel, each degrading to "nothing" on its own.
 * A jobs page that fails must not blank the downloads, and vice versa — this
 * panel sits under a dialog that has its own job to do.
 */
async function readHistory(client: ApiClient, projectId: string): Promise<HistorySnapshot> {
  const [list, jobs] = await Promise.all([
    client.call(exportListEndpoint, { params: { projectId } }).catch(() => null),
    client
      .call(endpoints.jobs.list, { query: { projectId, limit: JOB_PAGE_SIZE } })
      .catch(() => null),
  ]);

  return {
    loaded: true,
    exports: list?.items ?? [],
    activeJobs: (jobs?.items ?? []).filter(
      (job) => RENDER_JOB_TYPES.has(job.type) && isJobInFlight(job),
    ),
  };
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

type ChipTone = "warning" | "accent" | "rejected";

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
  const failed = item.status === "failed";
  return {
    key: "export:" + item.id,
    at: item.createdAt,
    label: describeExport(item),
    chip: succeeded ? "Succeeded" : failed ? "Failed" : "Rendering in this browser",
    tone: succeeded ? "accent" : failed ? "rejected" : "warning",
    watermarked: item.watermarked,
    downloadId: succeeded ? item.id : null,
  };
}

function jobRow(job: JobSummary): Row {
  const what = job.type === "render.subtitle" ? "Subtitles" : "Video";
  return {
    key: "job:" + job.id,
    at: job.queuedAt,
    label: what + " · cloud render",
    chip: job.status === "running" ? "Running — " + String(job.progress) + "%" : "Queued",
    tone: "warning",
    watermarked: false,
    downloadId: null,
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

  // One poller. It starts on mount and only re-arms while a render job is still
  // in flight — with every row settled there is nothing left that can change
  // without a click, so the timer is simply not scheduled again.
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const tick = async (): Promise<void> => {
      const next = await readHistory(client, projectId);
      if (stopped) return;
      setSnapshot(next);
      if (next.activeJobs.length === 0) return;
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

  const active = snapshot.activeJobs.length > 0;
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
  const rows: readonly Row[] = [
    ...snapshot.activeJobs.map(jobRow),
    ...snapshot.exports.map(exportRow),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <section className="mt-6" data-testid="export-history">
      <h3 className="text-fg-2 text-xs font-medium">Previous exports</h3>

      {snapshot.loaded && rows.length === 0 ? (
        <p className="text-fg-3 mt-2 text-xs">No exports yet.</p>
      ) : null}

      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-center gap-2 text-xs"
            data-testid="export-history-row"
          >
            <span className="text-fg-3 shrink-0">{relativeTime(row.at, now)}</span>
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
              <span className="text-red-400" data-testid="export-history-download-error">
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
