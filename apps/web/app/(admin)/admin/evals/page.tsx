"use client";

import * as React from "react";

import { Badge, Button, Field, Input, PageHeader } from "@montaj/ui";

import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminPage,
  AdminSection,
  AdminTable,
  td,
  th,
  tr,
} from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

interface LeaderboardRow {
  dataset: string;
  kind: string;
  language: string;
  provider?: string;
  metricName: string;
  metricValue: number;
  previousMetricValue?: number;
  trend?: number;
  itemCount: number;
  runId: string;
  measuredAt: string;
}

interface RoutingFreezeState {
  frozen: boolean;
  reason?: string;
  updatedBy?: string;
  updatedAt: string;
}

/**
 * Eval harness leaderboard + routing freeze (D08 §6). Route-quality metrics
 * A10 already exposes (`GET /providers`) stay the live view of what is
 * routing *now*; this panel is the harness's own retrospective — nightly
 * measurement, trend vs. the previous run, and the freeze switch that pins
 * the chain when a regression needs a human before it ships further.
 */
export default function AdminEvalsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [rows, setRows] = React.useState<LeaderboardRow[] | null>(null);
  const [freeze, setFreeze] = React.useState<RoutingFreezeState | null>(null);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    adminFetch<LeaderboardRow[]>("/admin/evals/leaderboard")
      .then(setRows)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."));
    adminFetch<RoutingFreezeState>("/admin/evals/freeze")
      .then(setFreeze)
      .catch(() => undefined);
  }, [adminFetch]);

  React.useEffect(load, [load]);

  async function toggleFreeze(next: boolean): Promise<void> {
    try {
      const updated = await adminFetch<RoutingFreezeState>(
        next ? "/admin/evals/freeze" : "/admin/evals/unfreeze",
        { method: "POST", body: { reason } },
      );
      setFreeze(updated);
      setReason("");
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Freeze update failed.");
    }
  }

  const frozen = freeze?.frozen === true;

  return (
    <AdminPage>
      <PageHeader
        eyebrow="Platform"
        title="Eval leaderboard"
        description="Nightly harness results against the previous run, and the switch that pins provider routing while a regression is looked at."
      />
      {error !== null && <AdminError>{error}</AdminError>}

      <AdminSection
        title="Routing freeze"
        description="Freezing pins the current routing chain. A reason is mandatory and audited."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-1">
            <span>Status</span>
            {freeze === null ? (
              <span className="text-fg-2">Unknown</span>
            ) : frozen ? (
              <Badge tone="warning">Frozen</Badge>
            ) : (
              <Badge>Not frozen</Badge>
            )}
            {freeze?.reason !== undefined && frozen ? (
              <span className="text-fg-2">{freeze.reason}</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Reason" htmlFor="freeze-reason" className="flex-1">
              <Input
                id="freeze-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why the chain is being frozen or released"
              />
            </Field>
            <div className="flex gap-2">
              <Button
                variant={frozen ? "ghost" : "secondary"}
                onClick={() => void toggleFreeze(true)}
              >
                Freeze routing
              </Button>
              <Button
                variant={frozen ? "secondary" : "ghost"}
                onClick={() => void toggleFreeze(false)}
              >
                Unfreeze
              </Button>
            </div>
          </div>
        </div>
      </AdminSection>

      <AdminSection
        title="Latest runs"
        description="Trend is the change since the previous run; a rise is a regression."
        bare
      >
        {rows === null ? (
          error === null ? (
            <AdminLoading />
          ) : null
        ) : rows.length === 0 ? (
          <AdminEmpty
            title="No eval runs yet"
            description="Results appear here after the nightly harness first runs."
          />
        ) : (
          <AdminTable label="Eval leaderboard">
            <thead>
              <tr>
                <th className={th}>Dataset</th>
                <th className={th}>Language</th>
                <th className={th}>Metric</th>
                <th className={`${th} text-right`}>Value</th>
                <th className={`${th} text-right`}>Trend</th>
                <th className={`${th} text-right`}>Items</th>
                <th className={th}>Measured</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.dataset}-${row.language}-${row.provider ?? ""}-${row.metricName}`}
                  className={tr}
                >
                  <td className={td}>
                    <span className="text-fg-0">{row.dataset}</span>{" "}
                    <span className="text-fg-2">({row.kind})</span>
                  </td>
                  <td className={td}>{row.language}</td>
                  <td className={td}>{row.metricName}</td>
                  <td className={`${td} text-right font-mono tabular-nums`}>
                    {row.metricValue.toFixed(4)}
                  </td>
                  <td className={`${td} text-right font-mono whitespace-nowrap tabular-nums`}>
                    {row.trend === undefined ? (
                      <span className="text-fg-2">—</span>
                    ) : row.trend === 0 ? (
                      <span className="text-fg-2">
                        {row.trend.toFixed(4)} <span className="font-sans text-xs">no change</span>
                      </span>
                    ) : (
                      <span className={row.trend > 0 ? "text-rejected" : "text-accepted"}>
                        {row.trend > 0 ? "+" : ""}
                        {row.trend.toFixed(4)}{" "}
                        <span className="font-sans text-xs">
                          {row.trend > 0 ? "worse" : "better"}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{row.itemCount}</td>
                  <td className={`${td} whitespace-nowrap text-fg-2`}>
                    {new Date(row.measuredAt).toLocaleString()}
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
