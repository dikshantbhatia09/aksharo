"use client";

import * as React from "react";

import { Button, Field, Input, PageHeader, Textarea } from "@montaj/ui";

import {
  AdminError,
  AdminPage,
  AdminSelect,
  AdminSuccess,
  adminCard,
} from "@/components/admin/admin-ui";
import { AdminFetchError, useAdminFetch } from "@/lib/admin/use-admin-fetch";

const REASON_CODES = [
  "customer_request",
  "quality_issue",
  "duplicate_charge",
  "billing_error",
  "goodwill",
  "other",
] as const;

/** What an operator reads; the API still receives the code itself. */
const REASON_LABELS = new Map<(typeof REASON_CODES)[number], string>([
  ["customer_request", "Customer request"],
  ["quality_issue", "Quality issue"],
  ["duplicate_charge", "Duplicate charge"],
  ["billing_error", "Billing error"],
  ["goodwill", "Goodwill"],
  ["other", "Other"],
]);

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
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setResult(null);
    setPending(true);
    try {
      const response = await adminFetch<AdminRefundResult>(
        `/admin/billing/passes/${passPurchaseId}/refund`,
        { method: "POST", body: { providerPaymentId, reasonCode, reason } },
      );
      setResult(response);
    } catch (err) {
      setError(err instanceof AdminFetchError ? err.message : "Refund failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AdminPage width="form">
      <PageHeader
        eyebrow="Money"
        title="Refund a pass/top-up purchase"
        description="The refund amount is set by policy on the server: in full within 7 days, pro rata by unspent credits after that. Finance and superadmin only."
      />
      <form onSubmit={submit} className={`${adminCard} flex flex-col gap-4`}>
        <Field label="Pass purchase ID" htmlFor="refund-pass-id">
          <Input
            id="refund-pass-id"
            value={passPurchaseId}
            onChange={(e) => setPassPurchaseId(e.target.value)}
            className="font-mono"
            autoComplete="off"
            required
          />
        </Field>
        <Field label="Provider payment ID" htmlFor="refund-payment-id" hint="For example pay_…">
          <Input
            id="refund-payment-id"
            value={providerPaymentId}
            onChange={(e) => setProviderPaymentId(e.target.value)}
            className="font-mono"
            autoComplete="off"
            required
          />
        </Field>
        <Field label="Reason code" htmlFor="refund-reason-code">
          <AdminSelect
            id="refund-reason-code"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as (typeof REASON_CODES)[number])}
          >
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {REASON_LABELS.get(code) ?? code}
              </option>
            ))}
          </AdminSelect>
        </Field>
        <Field
          label="Reason (min 10 characters)"
          htmlFor="refund-reason"
          hint="Written to the audit log with your name."
        >
          <Textarea
            id="refund-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            required
          />
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            data-testid="admin-refund-submit"
          >
            {pending ? "Refunding…" : "Issue refund"}
          </Button>
        </div>
      </form>
      {result !== null && (
        <AdminSuccess data-testid="admin-refund-result">
          <p>
            {result.policy} refund of ₹{(result.refundAmountMinor / 100).toFixed(2)} —{" "}
            {result.outcome}
          </p>
          {result.creditNoteId !== undefined && (
            <p>
              Credit note: <span className="font-mono">{result.creditNoteId}</span>
            </p>
          )}
          {result.creditNoteSkippedReason !== undefined && <p>{result.creditNoteSkippedReason}</p>}
        </AdminSuccess>
      )}
      {error !== null && <AdminError data-testid="admin-refund-error">{error}</AdminError>}
    </AdminPage>
  );
}
