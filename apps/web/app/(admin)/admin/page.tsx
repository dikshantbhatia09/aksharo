"use client";

import * as React from "react";

import { PageHeader } from "@montaj/ui";

import { AdminPage, AdminSection, StatTile } from "@/components/admin/admin-ui";
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
  // `null` until the request answers, so a slow or failed fetch reads "—"
  // rather than a confident zero.
  const [jobStats, setJobStats] = React.useState<QueueStats[] | null>(null);
  const [dunning, setDunning] = React.useState<DunningEntry[] | null>(null);
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

  const failedTotal = jobStats?.reduce((sum, s) => sum + s.failed, 0);
  const runningTotal = jobStats?.reduce((sum, s) => sum + s.running, 0);

  return (
    <AdminPage>
      <PageHeader
        eyebrow="Admin console"
        title={<span data-testid="admin-heading">Dashboard</span>}
        description="Queue health and billing risk right now, then the latest growth snapshots."
      />

      <AdminSection title="Right now" bare>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatTile label="Jobs running" value={runningTotal ?? "—"} />
          <StatTile label="Jobs failed" value={failedTotal ?? "—"} />
          <StatTile label="Subscriptions past due" value={dunning?.length ?? "—"} />
        </div>
      </AdminSection>

      <AdminSection
        title="Growth snapshots"
        description="Each chart is a single snapshot over its window, not a daily trend."
        bare
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <BarChart
            title="Acquisition by source"
            caption={
              acquisition === null
                ? undefined
                : `${String(acquisition.totalOnboardingCompleted)} onboarded, last ${String(acquisition.windowDays)} days`
            }
            data={(acquisition?.bySource ?? []).map((row) => ({
              label: row.key,
              value: row.count,
            }))}
          />
          <BarChart
            title="Streak: experiment vs holdout"
            caption="Week-4 retention, per cent"
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
      </AdminSection>
    </AdminPage>
  );
}
