"use client";

import * as React from "react";

import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@montaj/ui";

import { FreeStackBillingNotice } from "./free-stack-notice";

import { useRuntimeConfig } from "@/components/providers";
import { useMandates, usePaymentMethods, useRevokeMandate } from "@/lib/billing/hooks";
import { formatDate, formatDateTime, formatMoney, MANDATE_METHOD_LABEL } from "@/lib/billing/money";
import { messageForError } from "@/lib/errors";

/** `/billing/methods` (08 §Subscription: "Payment methods"). */
export function PaymentMethodsPanel(): React.JSX.Element {
  const { razorpayEnabled } = useRuntimeConfig();
  // Both queries stay behind the rail: with no Razorpay there are no methods and
  // no mandates to have, so fetching only produces the empty state that used to
  // sit on top of a server error and hide it (F07-C2).
  const methods = usePaymentMethods({ enabled: razorpayEnabled });
  const mandates = useMandates({ enabled: razorpayEnabled });
  const revoke = useRevokeMandate();
  const [revokeTarget, setRevokeTarget] = React.useState<string | null>(null);

  const confirmRevoke = (): void => {
    if (revokeTarget === null) return;
    revoke.mutate(revokeTarget, {
      onSuccess: () => {
        setRevokeTarget(null);
        toast.success("Mandate revoked", {
          description: "The linked subscription was cancelled too.",
        });
      },
      onError: (error) => {
        toast.error("Could not revoke that mandate", { description: messageForError(error) });
      },
    });
  };

  // After the hooks, never before them: the rules of hooks are why the queries
  // are gated above rather than simply skipped here.
  if (!razorpayEnabled) return <FreeStackBillingNotice />;

  return (
    <div className="flex flex-col gap-6" data-testid="payment-methods-panel">
      <section className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-lg font-semibold">On file</h2>
        {methods.isPending ? (
          <p className="text-fg-2 text-sm">Loading…</p>
        ) : methods.data === undefined || methods.data.length === 0 ? (
          <p className="text-fg-2 text-sm">
            Nothing on file yet — it appears after your first checkout.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {methods.data.map((method, index) => (
              <li key={`${method.method}-${String(index)}`}>
                <Card
                  className="flex items-center justify-between py-3"
                  data-testid="payment-method-row"
                >
                  <span className="text-fg-0 text-sm">
                    {method.label}
                    {method.last4 === undefined ? "" : ` •••• ${method.last4}`}
                  </span>
                  {method.isDefault === true ? <Badge tone="accent">Default</Badge> : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-lg font-semibold">Mandates</h2>
        {mandates.isPending ? (
          <p className="text-fg-2 text-sm">Loading…</p>
        ) : mandates.data === undefined || mandates.data.length === 0 ? (
          <p className="text-fg-2 text-sm">No recurring mandate yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {mandates.data.map((mandate) => (
              <li key={mandate.id}>
                <Card className="flex flex-col gap-2" data-testid="mandate-row">
                  <div className="flex items-center justify-between">
                    <span className="text-fg-0 text-sm font-medium">
                      {MANDATE_METHOD_LABEL[mandate.method] ?? mandate.method}
                    </span>
                    <Badge tone={mandate.status === "active" ? "accent" : "neutral"}>
                      {mandate.status}
                    </Badge>
                  </div>
                  <p className="text-fg-2 text-xs">
                    Capped at {formatMoney(mandate.maxAmountMinor, mandate.currency)} per debit
                    {mandate.afaRequiredPerDebit
                      ? " · fresh authentication required every debit"
                      : ""}
                  </p>
                  <p className="text-fg-2 text-xs">
                    Valid from {formatDate(mandate.validFrom)}
                    {mandate.validUntil === null ? "" : ` to ${formatDate(mandate.validUntil)}`}
                  </p>
                  <p className="text-fg-2 text-xs">
                    Next debit needs a 24-hour pre-debit notice before it is charged.
                  </p>
                  {mandate.status === "active" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      data-testid="revoke-mandate"
                      onClick={() => {
                        setRevokeTarget(mandate.id);
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this mandate?</DialogTitle>
            <DialogDescription>
              This cancels the subscription it pays for too — access continues until the current
              period ends, then the plan reverts to Free. This cannot be undone from here; you would
              need to check out again to resume.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setRevokeTarget(null);
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              disabled={revoke.isPending}
              data-testid="confirm-revoke-mandate"
              onClick={confirmRevoke}
            >
              Revoke mandate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Re-exported so a test can assert the "24-hour notice" copy without a DOM query. */
export function nextDebitNoticeText(nextDebitAt: string | null): string {
  if (nextDebitAt === null) return "No debit scheduled.";
  return `Next debit ${formatDateTime(nextDebitAt)} — at least 24 hours' notice is sent first.`;
}
