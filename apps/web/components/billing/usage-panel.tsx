"use client";

import * as React from "react";

import { Button } from "@montaj/ui";

import type { UsageEntry } from "@/lib/billing/types";

import { useCreditsSummary, useUsagePage } from "@/lib/billing/hooks";
import { formatDate, formatDateTime } from "@/lib/billing/money";
import { messageForError } from "@/lib/errors";

const KIND_LABEL: Record<string, string> = {
  grant: "Monthly grant",
  purchase: "Purchase",
  hold: "Held",
  settle: "Settled",
  release: "Released",
  reversal: "Reversed",
  refund: "Refunded",
  adjust: "Adjustment",
  expire: "Expired",
  referral_bonus: "Referral bonus",
};

/** `tenths` → "12.5", signed. */
function formatDelta(tenths: number): string {
  const value = tenths / 10;
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number.isInteger(value) ? String(value) : value.toFixed(1)}`;
}

/** RFC 4180 escaping for one field. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function usageToCsv(entries: readonly UsageEntry[]): string {
  const header = [
    "date",
    "kind",
    "delta_credits",
    "balance_after_credits",
    "ref_type",
    "ref_id",
    "job_type",
  ];
  const rows = entries.map((entry) =>
    [
      entry.at,
      entry.kind,
      String(entry.deltaTenths / 10),
      String(entry.balanceAfterTenths / 10),
      entry.refType,
      entry.refId ?? "",
      entry.jobType ?? "",
    ]
      .map(csvField)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * `/billing/usage` (08 §Subscription: "Usage"). `nested` drops its section
 * headings to `h3` when it sits under another section heading (the
 * Overview's "Where the credits went"), so the outline never skips back up.
 */
export function UsagePanel({
  nested = false,
}: {
  readonly nested?: boolean;
} = {}): React.JSX.Element {
  const Heading = nested ? "h3" : "h2";
  const usage = useUsagePage();
  const credits = useCreditsSummary();

  const exportCsv = (): void => {
    if (usage.data === undefined) return;
    downloadCsv(
      usageToCsv(usage.data.items),
      `credit-usage-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };

  return (
    <div className="flex flex-col gap-6" data-testid="usage-panel">
      {credits.data !== undefined && credits.data.lots.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Heading className="text-fg-0 text-base font-semibold">Credit lots</Heading>
          <ul
            className="border-border bg-surface divide-border flex flex-col divide-y rounded-md border"
            data-testid="usage-lots"
          >
            {credits.data.lots.map((lot) => (
              <li
                key={lot.id}
                className="text-fg-1 flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm"
              >
                <span className="capitalize">{lot.source}</span>
                <span>
                  {lot.remainingTenths / 10} of {lot.grantedTenths / 10} left
                  {lot.expiresAt === null ? "" : ` · expires ${formatDate(lot.expiresAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Heading className="text-fg-0 text-base font-semibold">History</Heading>
          <Button
            variant="secondary"
            size="sm"
            disabled={usage.data === undefined || usage.data.items.length === 0}
            data-testid="export-usage-csv"
            onClick={exportCsv}
          >
            Download CSV
          </Button>
        </div>

        {usage.isPending ? (
          <p className="text-fg-2 text-sm">Loading…</p>
        ) : usage.isError ? (
          <p className="text-rejected text-sm" role="alert">
            {messageForError(usage.error)}
          </p>
        ) : usage.data.items.length === 0 ? (
          <p className="text-fg-2 text-sm" data-testid="usage-empty">
            No credit activity yet. Transcribing or exporting a project shows up here.
          </p>
        ) : (
          <ul
            className="border-border bg-surface divide-border flex flex-col divide-y rounded-md border"
            data-testid="usage-list"
          >
            {usage.data.items.map((entry) => (
              <li key={entry.id}>
                <div
                  className="flex items-center justify-between gap-4 px-4 py-3"
                  data-testid="usage-row"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-fg-0 text-sm">
                      {KIND_LABEL[entry.kind] ?? entry.kind}
                    </span>
                    <span className="text-fg-2 text-xs">
                      {formatDateTime(entry.at)}
                      {entry.jobType === null ? "" : ` · ${entry.jobType}`}
                    </span>
                  </div>
                  <span
                    className={
                      entry.deltaTenths >= 0
                        ? "text-accepted text-sm tabular-nums"
                        : "text-fg-1 text-sm tabular-nums"
                    }
                  >
                    {formatDelta(entry.deltaTenths)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
