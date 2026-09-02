"use client";

import * as React from "react";

import { Badge, Button, Card, toast } from "@montaj/ui";

import type { InvoiceRow } from "@/lib/billing/types";

import { useInvoiceDownloadUrl, useInvoices } from "@/lib/billing/hooks";
import { formatDate, formatMoney } from "@/lib/billing/money";
import { messageForError } from "@/lib/errors";

const DOC_TYPE_LABEL: Record<string, string> = {
  tax_invoice: "Tax invoice",
  export_invoice: "Export invoice",
  bill_of_supply: "Bill of supply",
  credit_note: "Credit note",
  debit_note: "Debit note",
  self_invoice: "Self-invoice",
};

/**
 * `/billing/invoices` (08 §Subscription: "Invoices"). Built against the
 * `invoices` row shape of `06-data-model.md` — see the B03 report for why
 * `GET /invoices` may still 404 (B05 in flight): `useInvoices` treats that as
 * an empty list, so this page never shows an error banner for a route that
 * simply has not landed yet.
 */
export function InvoicesPanel(): React.JSX.Element {
  const invoices = useInvoices();
  const download = useInvoiceDownloadUrl();

  const byId = React.useMemo(() => {
    const map = new Map<string, InvoiceRow>();
    for (const invoice of invoices.data ?? []) map.set(invoice.id, invoice);
    return map;
  }, [invoices.data]);

  const openDownload = (invoiceId: string): void => {
    download.mutate(invoiceId, {
      onSuccess: (result) => {
        window.open(result.url, "_blank", "noopener,noreferrer");
      },
      onError: (error) => {
        toast.error("Could not open that invoice", { description: messageForError(error) });
      },
    });
  };

  if (invoices.isPending) {
    return (
      <p className="text-fg-2 text-sm" data-testid="invoices-loading">
        Loading invoices…
      </p>
    );
  }

  if (invoices.isError) {
    return (
      <p className="text-rejected text-sm" role="alert">
        {messageForError(invoices.error)}
      </p>
    );
  }

  if (invoices.data.length === 0) {
    return (
      <p className="text-fg-2 text-sm" data-testid="invoices-empty">
        No invoices yet — one appears here after your first payment.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="invoices-list">
      {invoices.data.map((invoice) => {
        const related =
          invoice.relatedInvoiceId === null ? undefined : byId.get(invoice.relatedInvoiceId);
        return (
          <li key={invoice.id}>
            <Card className="flex flex-col gap-2" data-testid="invoice-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={invoice.docType === "credit_note" ? "warning" : "neutral"}>
                    {DOC_TYPE_LABEL[invoice.docType] ?? invoice.docType}
                  </Badge>
                  <span className="text-fg-0 text-sm font-medium">
                    {invoice.series}/{invoice.number}
                  </span>
                </div>
                <span className="text-fg-2 text-xs">{formatDate(invoice.issuedAt)}</span>
              </div>

              {related === undefined ? null : (
                <p className="text-fg-2 text-xs">
                  Linked to invoice {related.series}/{related.number}
                </p>
              )}

              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-fg-0 text-lg font-semibold">
                  {formatMoney(invoice.totalMinor, invoice.currency)}
                </span>
                {invoice.currency === "INR" ? (
                  <span className="text-fg-2 text-xs" data-testid="invoice-gst-breakup">
                    taxable {formatMoney(invoice.taxableValueMinor, "INR")}
                    {invoice.cgstMinor > 0
                      ? ` · CGST ${formatMoney(invoice.cgstMinor, "INR")}`
                      : ""}
                    {invoice.sgstMinor > 0
                      ? ` · SGST ${formatMoney(invoice.sgstMinor, "INR")}`
                      : ""}
                    {invoice.igstMinor > 0
                      ? ` · IGST ${formatMoney(invoice.igstMinor, "INR")}`
                      : ""}
                  </span>
                ) : null}
              </div>

              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={download.isPending}
                data-testid="download-invoice"
                onClick={() => {
                  openDownload(invoice.id);
                }}
              >
                Download PDF
              </Button>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
