"use client";

import { useSearchParams } from "next/navigation";
import * as React from "react";

import { Button, cn, Field, Input, PageHeader, Textarea } from "@montaj/ui";

import { AdminError, AdminPage, AdminSuccess, adminCard } from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

const MODES = [
  { value: "adjust", label: "Grant credits", hint: "Adds an adjustment lot to the workspace." },
  { value: "reverse", label: "Reverse a job charge", hint: "Refunds what one job was charged." },
] as const;

/**
 * `POST /admin/credits/adjust` and `/reverse` — finance/superadmin only
 * (`AdminGuard`/`@AdminRoles`, enforced server-side; a support-role admin
 * sees this form but every submit 403s, per the brief's own e2e case).
 */
export default function AdminCreditsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const params = useSearchParams();
  const [workspaceId, setWorkspaceId] = React.useState(params.get("workspaceId") ?? "");
  const [tenths, setTenths] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [jobId, setJobId] = React.useState("");
  const [mode, setMode] = React.useState<"adjust" | "reverse">("adjust");
  const [result, setResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      const body =
        mode === "adjust"
          ? { workspaceId, tenths: Number(tenths), reason }
          : { workspaceId, jobId, tenths: Number(tenths), reason };
      const response = await adminFetch<{ lotId?: string; lotIds?: string[] }>(
        `/admin/credits/${mode}`,
        { method: "POST", body },
      );
      setResult(JSON.stringify(response));
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Request failed.");
    }
  }

  return (
    <AdminPage width="form">
      <PageHeader
        eyebrow="Money"
        title="Credits"
        description="Grant credits to a workspace or reverse what a job was charged. Finance and superadmin only; every change is audited."
      />
      <div className={`${adminCard} flex flex-col gap-5`}>
        <div
          role="group"
          aria-label="What to do"
          className="grid grid-cols-1 gap-1 rounded-sm border border-border bg-sunken p-1 sm:grid-cols-2"
        >
          {MODES.map((option) => {
            const selected = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(option.value)}
                className={cn(
                  "min-h-8 rounded-sm px-3 py-1.5 text-sm transition-colors",
                  selected
                    ? "bg-bg-2 font-medium text-fg-0 shadow-sm"
                    : "text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="-mt-2 text-xs text-fg-2">
          {MODES.find((option) => option.value === mode)?.hint}
        </p>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Workspace ID" htmlFor="credits-workspace-id">
            <Input
              id="credits-workspace-id"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="font-mono"
              autoComplete="off"
              required
            />
          </Field>
          {mode === "reverse" && (
            <Field label="Job ID" htmlFor="credits-job-id">
              <Input
                id="credits-job-id"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                className="font-mono"
                autoComplete="off"
                required
              />
            </Field>
          )}
          <Field
            label="Tenths of a credit"
            htmlFor="credits-tenths"
            hint="10 tenths make 1 credit."
          >
            <Input
              id="credits-tenths"
              value={tenths}
              onChange={(e) => setTenths(e.target.value)}
              type="number"
              min={1}
              inputMode="numeric"
              required
            />
          </Field>
          <Field
            label="Reason (min 10 characters)"
            htmlFor="credits-reason"
            hint="Written to the audit log with your name."
          >
            <Textarea
              id="credits-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              required
            />
          </Field>
          <div>
            <Button type="submit" variant="primary">
              {mode === "adjust" ? "Grant credits" : "Reverse charge"}
            </Button>
          </div>
        </form>
      </div>
      {result !== null && (
        <AdminSuccess>
          <p>Done. The ledger recorded:</p>
          <p className="mt-1 font-mono text-xs break-all text-fg-1">{result}</p>
        </AdminSuccess>
      )}
      {error !== null && <AdminError data-testid="admin-credits-error">{error}</AdminError>}
    </AdminPage>
  );
}
