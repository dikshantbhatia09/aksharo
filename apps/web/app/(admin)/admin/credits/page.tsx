"use client";

import { useSearchParams } from "next/navigation";
import * as React from "react";

import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

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
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Credits</h1>
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("adjust")}
          className={`rounded px-3 py-1 ${mode === "adjust" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-300"}`}
        >
          Adjust (grant)
        </button>
        <button
          type="button"
          onClick={() => setMode("reverse")}
          className={`rounded px-3 py-1 ${mode === "reverse" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-300"}`}
        >
          Reverse (job charge)
        </button>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Workspace ID
          <input
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
            required
          />
        </label>
        {mode === "reverse" && (
          <label className="flex flex-col gap-1">
            Job ID
            <input
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
              required
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          Tenths of a credit
          <input
            value={tenths}
            onChange={(e) => setTenths(e.target.value)}
            type="number"
            min={1}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          Reason (min 10 characters — mandatory)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
            required
          />
        </label>
        <button type="submit" className="w-fit rounded bg-neutral-100 px-4 py-2 text-neutral-900">
          Submit
        </button>
      </form>
      {result !== null && <p className="text-sm text-green-400">{result}</p>}
      {error !== null && (
        <p data-testid="admin-credits-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
