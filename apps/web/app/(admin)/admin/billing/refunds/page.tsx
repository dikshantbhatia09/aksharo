"use client";

import * as React from "react";

import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

const REASON_CODES = [
  "customer_request",
  "quality_issue",
  "duplicate_charge",
  "billing_error",
  "goodwill",
  "other",
] as const;

interface AdminRefundResult {
  outcome: string;
  policy: string;
  refundAmountMinor: number;
  creditNoteId?: string;
  creditNoteSkippedReason?: string;
}

/**
 * `POST /admin/billing/passes/:id/refund` — finance/superadmin only.
 * Policy (within 7 days full; pro-rata by unspent credits otherwise) is
 * computed server-side; this form only supplies the reason.
 */
export default function AdminRefundsPage(): React.JSX.Element {
  const adminFetch = useAdminFetch();
  const [passPurchaseId, setPassPurchaseId] = React.useState("");
  const [providerPaymentId, setProviderPaymentId] = React.useState("");
  const [reasonCode, setReasonCode] =
    React.useState<(typeof REASON_CODES)[number]>("customer_request");
  const [reason, setReason] = React.useState("");
  const [result, setResult] = React.useState<AdminRefundResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      const response = await adminFetch<AdminRefundResult>(
        `/admin/billing/passes/${passPurchaseId}/refund`,
        { method: "POST", body: { providerPaymentId, reasonCode, reason } },
      );
      setResult(response);
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Refund failed.");
    }
  }

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-100">Refund a pass/top-up purchase</h1>
      <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Pass purchase ID
          <input
            value={passPurchaseId}
            onChange={(e) => setPassPurchaseId(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          Provider payment ID
          <input
            value={providerPaymentId}
            onChange={(e) => setProviderPaymentId(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          Reason code
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as (typeof REASON_CODES)[number])}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100"
          >
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
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
        <button
          type="submit"
          data-testid="admin-refund-submit"
          className="w-fit rounded bg-neutral-100 px-4 py-2 text-neutral-900"
        >
          Refund
        </button>
      </form>
      {result !== null && (
        <div data-testid="admin-refund-result" className="text-sm text-green-400">
          <p>
            {result.policy} refund of ₹{(result.refundAmountMinor / 100).toFixed(2)} —{" "}
            {result.outcome}
          </p>
          {result.creditNoteId !== undefined && <p>Credit note: {result.creditNoteId}</p>}
          {result.creditNoteSkippedReason !== undefined && <p>{result.creditNoteSkippedReason}</p>}
        </div>
      )}
      {error !== null && (
        <p data-testid="admin-refund-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
