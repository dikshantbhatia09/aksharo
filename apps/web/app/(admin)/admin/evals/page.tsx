"use client";

import * as React from "react";

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
  const [rows, setRows] = React.useState<LeaderboardRow[]>([]);
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

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-neutral-100">Eval leaderboard</h1>
      {error !== null && <p className="text-sm text-red-400">{error}</p>}

      <div className="rounded border border-neutral-800 p-4">
        <p className="text-xs text-neutral-500">Routing freeze</p>
        <p className="text-lg text-neutral-100">
          {freeze?.frozen ? "Frozen" : "Not frozen"}
          {freeze?.reason !== undefined && freeze.frozen ? ` — ${freeze.reason}` : ""}
        </p>
        <div className="mt-2 flex max-w-md gap-2 text-sm">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="reason (mandatory, audited)"
            className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
          />
          <button
            type="button"
            onClick={() => void toggleFreeze(true)}
            className="rounded bg-red-900 px-3 py-1.5 text-neutral-100"
          >
            Freeze
          </button>
          <button
            type="button"
            onClick={() => void toggleFreeze(false)}
            className="rounded bg-neutral-800 px-3 py-1.5 text-neutral-100"
          >
            Unfreeze
          </button>
        </div>
      </div>

      <table className="w-full text-left text-sm text-neutral-300">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-4">Dataset</th>
            <th className="py-1 pr-4">Language</th>
            <th className="py-1 pr-4">Metric</th>
            <th className="py-1 pr-4">Value</th>
            <th className="py-1 pr-4">Trend</th>
            <th className="py-1 pr-4">Items</th>
            <th className="py-1 pr-4">Measured</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.dataset}-${row.language}-${row.provider ?? ""}-${row.metricName}`}
              className="border-t border-neutral-800"
            >
              <td className="py-1 pr-4">
                {row.dataset} <span className="text-neutral-600">({row.kind})</span>
              </td>
              <td className="py-1 pr-4">{row.language}</td>
              <td className="py-1 pr-4">{row.metricName}</td>
              <td className="py-1 pr-4">{row.metricValue.toFixed(4)}</td>
              <td
                className={`py-1 pr-4 ${
                  row.trend === undefined
                    ? "text-neutral-600"
                    : row.trend > 0
                      ? "text-red-400"
                      : "text-emerald-400"
                }`}
              >
                {row.trend === undefined ? "—" : row.trend.toFixed(4)}
              </td>
              <td className="py-1 pr-4">{row.itemCount}</td>
              <td className="py-1 pr-4">{new Date(row.measuredAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
