"use client";

import * as React from "react";

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

/** Cross-tenant job monitor (`GET /admin/jobs`, `/admin/jobs/stats`, `POST /admin/jobs/:id/cancel`). */
export default function AdminJobsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [stats, setStats] = React.useState<QueueStats[]>([]);
  const [jobs, setJobs] = React.useState<AdminJobSummary[]>([]);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    adminFetch<QueueStats[]>("/admin/jobs/stats")
      .then(setStats)
      .catch(() => undefined);
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
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Jobs</h1>
      <table className="w-full max-w-2xl text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Queue</th>
            <th className="py-1 pr-4">Queued</th>
            <th className="py-1 pr-4">Running</th>
            <th className="py-1 pr-4">Failed</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.queue} className="border-t border-neutral-800">
              <td className="py-1 pr-4">{s.queue}</td>
              <td className="py-1 pr-4">{s.queued}</td>
              <td className="py-1 pr-4">{s.running}</td>
              <td className="py-1 pr-4">{s.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        className="w-fit rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
      >
        <option value="">all statuses</option>
        <option value="queued">queued</option>
        <option value="running">running</option>
        <option value="failed">failed</option>
      </select>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}
      <table className="w-full text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Type</th>
            <th className="py-1 pr-4">Status</th>
            <th className="py-1 pr-4">Attempt</th>
            <th className="py-1 pr-4" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-t border-neutral-800">
              <td className="py-1.5 pr-4">{job.type}</td>
              <td className="py-1.5 pr-4">{job.status}</td>
              <td className="py-1.5 pr-4">{job.attemptNo}</td>
              <td className="py-1.5 pr-4">
                {(job.status === "queued" || job.status === "running") && (
                  <button
                    type="button"
                    onClick={() => void cancel(job.id)}
                    className="rounded bg-neutral-800 px-2 py-1 text-neutral-100"
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
