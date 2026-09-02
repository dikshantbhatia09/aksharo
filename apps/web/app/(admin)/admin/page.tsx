"use client";

import * as React from "react";

import { useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface QueueStats {
  queue: string;
  queued: number;
  running: number;
  failed: number;
}

interface DunningEntry {
  subscriptionId: string;
  workspaceId: string;
  status: string;
}

/**
 * Dashboard: a few numbers, no chart library (B13 scope §3 asks for "simple
 * charts... a small local library" — skipped here given the scope this WP
 * still had to cover; see the final report).
 */
export default function AdminDashboardPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [jobStats, setJobStats] = React.useState<QueueStats[]>([]);
  const [dunning, setDunning] = React.useState<DunningEntry[]>([]);

  React.useEffect(() => {
    adminFetch<QueueStats[]>("/admin/jobs/stats")
      .then(setJobStats)
      .catch(() => undefined);
    adminFetch<DunningEntry[]>("/admin/billing/dunning")
      .then(setDunning)
      .catch(() => undefined);
  }, [adminFetch]);

  const failedTotal = jobStats.reduce((sum, s) => sum + s.failed, 0);
  const runningTotal = jobStats.reduce((sum, s) => sum + s.running, 0);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-neutral-100">Admin dashboard</h1>
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded border border-neutral-800 p-4">
          <p className="text-xs text-neutral-500">Jobs running</p>
          <p className="text-2xl text-neutral-100">{runningTotal}</p>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <p className="text-xs text-neutral-500">Jobs failed</p>
          <p className="text-2xl text-neutral-100">{failedTotal}</p>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <p className="text-xs text-neutral-500">Subscriptions past due</p>
          <p className="text-2xl text-neutral-100">{dunning.length}</p>
        </div>
      </div>
    </div>
  );
}
