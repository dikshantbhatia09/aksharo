"use client";

import * as React from "react";

import { BarChart } from "@/components/admin/bar-chart";
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

interface AcquisitionMetrics {
  windowDays: number;
  totalOnboardingCompleted: number;
  bySource: { key: string; count: number }[];
  byCodeType: { key: string; count: number }[];
}

interface StreakCohortMetrics {
  experiment: { workspaces: number; week4RetentionPct: number; avgExportsPerWeek: number };
  holdout: { workspaces: number; week4RetentionPct: number; avgExportsPerWeek: number };
}

interface OffersMetrics {
  ninePass: { totalPurchases: number; upgradedWithinWindow: number };
}

/**
 * Dashboard, including the offers/streak/acquisition trend charts this WP's
 * brief §6 asks for, using `BarChart` (`components/admin/bar-chart.tsx`, no
 * CDN, no charting library).
 *
 * **Honest simplification**: none of the three source endpoints
 * (`admin/metrics/acquisition`, `.../offers`, `.../streak`) bucket their
 * numbers by day — `AdminAcquisitionService`/`AdminStreakService` return a
 * point-in-time snapshot over a rolling window, not a day-by-day series
 * (`admin-streak.service.ts`'s own query never groups by date). Building
 * real daily aggregation is a backend change none of those services'
 * owning work packages have made yet, so these charts render each
 * snapshot's own breakdown as bars (source, code type, experiment vs
 * holdout, purchases vs upgrades) rather than a time axis that would be
 * fabricated. See this WP's final report, "open questions", for the
 * follow-up: add a `by day` grouping to those three services and this page
 * becomes an actual trend line with no shape change to `BarChart` itself.
 */
export default function AdminDashboardPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [jobStats, setJobStats] = React.useState<QueueStats[]>([]);
  const [dunning, setDunning] = React.useState<DunningEntry[]>([]);
  const [acquisition, setAcquisition] = React.useState<AcquisitionMetrics | null>(null);
  const [streak, setStreak] = React.useState<StreakCohortMetrics | null>(null);
  const [offers, setOffers] = React.useState<OffersMetrics | null>(null);

  React.useEffect(() => {
    adminFetch<QueueStats[]>("/admin/jobs/stats")
      .then(setJobStats)
      .catch(() => undefined);
    adminFetch<DunningEntry[]>("/admin/billing/dunning")
      .then(setDunning)
      .catch(() => undefined);
    adminFetch<AcquisitionMetrics>("/admin/metrics/acquisition")
      .then(setAcquisition)
      .catch(() => undefined);
    adminFetch<StreakCohortMetrics>("/admin/metrics/streak")
      .then(setStreak)
      .catch(() => undefined);
    adminFetch<OffersMetrics>("/admin/metrics/offers")
      .then(setOffers)
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

      <div className="grid grid-cols-3 gap-4">
        <BarChart
          title="Acquisition by source"
          caption={
            acquisition === null
              ? undefined
              : `${String(acquisition.totalOnboardingCompleted)} onboarded, last ${String(acquisition.windowDays)}d`
          }
          data={(acquisition?.bySource ?? []).map((row) => ({ label: row.key, value: row.count }))}
        />
        <BarChart
          title="Streak: experiment vs holdout"
          caption="Week-4 retention %"
          data={
            streak === null
              ? []
              : [
                  { label: "experiment", value: streak.experiment.week4RetentionPct },
                  { label: "holdout", value: streak.holdout.week4RetentionPct },
                ]
          }
        />
        <BarChart
          title="₹9 offer: purchases vs upgrades"
          data={
            offers === null
              ? []
              : [
                  { label: "purchases", value: offers.ninePass.totalPurchases },
                  { label: "upgraded", value: offers.ninePass.upgradedWithinWindow },
                ]
          }
        />
      </div>
    </div>
  );
}
