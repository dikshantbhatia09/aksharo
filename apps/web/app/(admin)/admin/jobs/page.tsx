"use client";

import * as React from "react";

import { Badge, Button, ConfirmAction, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSection,
  AdminSelect,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface AdminJobSummary {
  id: string;
  workspaceId: string;
  type: string;
  status: string;
  attemptNo: number;
  queuedAt: string;
}

interface QueueStats {
  queue: string;
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  cancelled: number;
}

type StatusTone = "neutral" | "info" | "accepted" | "rejected" | "warning";

/** Every status is written out; the tone is a second cue, never the only one. */
function statusTone(status: string): StatusTone {
  if (status === "failed") return "rejected";
  if (status === "running") return "info";
  if (status === "succeeded") return "accepted";
  if (status === "queued") return "warning";
  return "neutral";
}

/** Sentence case for display; the filter still sends the raw status. */
function statusLabel(status: string): string {
  return status.length === 0 ? status : `${status[0]?.toUpperCase() ?? ""}${status.slice(1)}`;
}

/** Cross-tenant job monitor (`GET /admin/jobs`, `/admin/jobs/stats`, `POST /admin/jobs/:id/cancel`). */
export default function AdminJobsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [stats, setStats] = React.useState<QueueStats[] | null>(null);
  const [jobs, setJobs] = React.useState<AdminJobSummary[] | null>(null);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [statsFailed, setStatsFailed] = React.useState(false);

  const load = React.useCallback(() => {
    adminFetch<QueueStats[]>("/admin/jobs/stats")
      .then((next) => {
        setStats(next);
        setStatsFailed(false);
      })
      .catch(() => setStatsFailed(true));
    adminFetch<AdminJobSummary[]>(`/admin/jobs${status === "" ? "" : `?status=${status}`}`)
      .then(setJobs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [adminFetch, status]);

  React.useEffect(load, [load]);

  async function cancel(id: string): Promise<void> {
    try {
      await adminFetch(`/admin/jobs/${id}/cancel`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Cancel failed.");
    }
  }

  return (
    <AdminPage>
      <PageHeader
        eyebrow="Platform"
        title="Jobs"
        description="Every workspace's jobs, by queue. Cancel a queued or running job that is stuck."
      />

      <AdminSection title="Queues" bare>
        {stats === null ? (
          statsFailed ? (
            <AdminError>Queue depth could not be loaded. Reload the page to try again.</AdminError>
          ) : (
            <AdminLoading />
          )
        ) : stats.length === 0 ? (
          <AdminEmpty title="No queues reported" />
        ) : (
          <AdminTable label="Queue depth" className="max-w-2xl">
            <thead>
              <tr>
                <th className={th}>Queue</th>
                <th className={`${th} text-right`}>Queued</th>
                <th className={`${th} text-right`}>Running</th>
                <th className={`${th} text-right`}>Failed</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.queue} className={tr}>
                  <td className={`${td} font-mono text-xs text-fg-0`}>{s.queue}</td>
                  <td className={`${td} text-right tabular-nums`}>{s.queued}</td>
                  <td className={`${td} text-right tabular-nums`}>{s.running}</td>
                  <td
                    className={`${td} text-right tabular-nums ${s.failed > 0 ? "font-medium text-rejected" : ""}`}
                  >
                    {s.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>

      <AdminSection
        title="Recent jobs"
        bare
        actions={
          <label className="flex items-center gap-2 text-sm text-fg-1">
            Status
            <AdminSelect value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="failed">Failed</option>
            </AdminSelect>
          </label>
        }
      >
        {error !== null && <AdminError>{error}</AdminError>}
        {jobs === null ? (
          error === null ? (
            <AdminLoading />
          ) : null
        ) : jobs.length === 0 ? (
          <AdminEmpty title="No jobs with this status" />
        ) : (
          <AdminTable label="Jobs">
            <thead>
              <tr>
                <th className={th}>Type</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Attempt</th>
                <th className={th}>Queued</th>
                <th className={th}>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className={tr}>
                  <td className={`${td} font-mono text-xs text-fg-0`}>{job.type}</td>
                  <td className={td}>
                    <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{job.attemptNo}</td>
                  <td className={`${td} whitespace-nowrap text-fg-2`}>
                    {new Date(job.queuedAt).toLocaleString()}
                  </td>
                  <td className={`${td} text-right`}>
                    {(job.status === "queued" || job.status === "running") && (
                      <ConfirmAction
                        title={`Cancel this ${job.type} job?`}
                        description="The job stops and its work so far is discarded. The person who started it has to run it again."
                        confirmLabel="Cancel job"
                        confirmTestId={`confirm-cancel-${job.id}`}
                        onConfirm={() => cancel(job.id)}
                        trigger={
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label={`Cancel ${job.type} job ${job.id}`}
                          >
                            Cancel job
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>
    </AdminPage>
  );
}
