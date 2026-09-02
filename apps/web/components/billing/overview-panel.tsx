"use client";

import Link from "next/link";
import * as React from "react";

import {
  Badge,
  Button,
  Card,
  CreditMeter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@montaj/ui";

import { CheckoutSheet } from "./checkout-sheet";

import { useRuntimeConfig } from "@/components/providers";
import { StreakWidget } from "@/components/streak/streak-widget";
import {
  useCancelSubscription,
  useCreditsSummary,
  useMandates,
  usePauseSubscription,
  useResumeSubscription,
  useSubscription,
} from "@/lib/billing/hooks";
import { formatDate, formatMoney, MANDATE_METHOD_LABEL } from "@/lib/billing/money";
import { messageForError } from "@/lib/errors";

const STATUS_LABEL: Record<string, string> = {
  pending: "Awaiting payment",
  active: "Active",
  past_due: "Payment past due",
  paused: "Paused",
  cancelled: "Cancelled",
  expired: "Expired",
};

const STATUS_TONE: Record<string, "accent" | "warning" | "rejected" | "neutral"> = {
  pending: "warning",
  active: "accent",
  past_due: "warning",
  paused: "neutral",
  cancelled: "rejected",
  expired: "rejected",
};

/** `/billing` (08 §Subscription: "Overview"). */
export function OverviewPanel(): React.JSX.Element {
  const subscription = useSubscription();
  const mandates = useMandates();
  const credits = useCreditsSummary();
  const config = useRuntimeConfig();
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();
  const pause = usePauseSubscription();

  const [confirmAction, setConfirmAction] = React.useState<"cancel" | "pause" | null>(null);
  const [upgradeOpen, setUpgradeOpen] = React.useState(false);

  const streakEnabled = config.flags["streak.enabled"] === true;

  const runAction = (action: "cancel" | "pause" | "resume"): void => {
    const mutation = action === "cancel" ? cancel : action === "pause" ? pause : resume;
    mutation.mutate(undefined, {
      onSuccess: () => {
        setConfirmAction(null);
        toast.success(
          action === "cancel"
            ? "Cancellation scheduled"
            : action === "pause"
              ? "Subscription paused"
              : "Subscription resumed",
        );
      },
      onError: (error) => {
        toast.error("That did not work", { description: messageForError(error) });
      },
    });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="billing-overview">
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card className="flex flex-col gap-4" data-testid="plan-card">
          {subscription.isPending ? (
            <p className="text-fg-2 text-sm">Loading your plan…</p>
          ) : subscription.data === null || subscription.data === undefined ? (
            <>
              <h2 className="text-fg-0 text-lg font-semibold">Free plan</h2>
              <p className="text-fg-2 text-sm">
                You are on the Free plan — 20 credits a month and one watermark-free export.
              </p>
              <Button variant="primary" asChild className="self-start">
                <Link href="/billing/plans">See plans</Link>
              </Button>
            </>
          ) : (
            <PlanSummary
              subscription={subscription.data}
              mandateMethod={
                mandates.data?.find((mandate) => mandate.id === subscription.data?.mandateId)
                  ?.method
              }
              onUpgrade={() => {
                setUpgradeOpen(true);
              }}
              onCancel={() => {
                setConfirmAction("cancel");
              }}
              onPause={() => {
                setConfirmAction("pause");
              }}
              onResume={() => {
                runAction("resume");
              }}
              busy={cancel.isPending || pause.isPending || resume.isPending}
            />
          )}

          <div className="flex gap-3 pt-2">
            <Button variant="outline" size="sm" asChild data-testid="billing-history-shortcut">
              <Link href="/billing/invoices">Billing history</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/billing/usage">Usage</Link>
            </Button>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card data-testid="credits-card">
            {credits.isPending ? (
              <p className="text-fg-2 text-sm">Loading credits…</p>
            ) : credits.data === undefined ? (
              <p className="text-fg-2 text-sm">{messageForError(credits.error)}</p>
            ) : (
              <>
                <CreditMeter
                  remainingTenths={credits.data.balanceTenths}
                  includedTenths={credits.data.monthlyGrantTenths}
                  resetsAt={credits.data.grantResetAt ?? undefined}
                  showStreak={streakEnabled}
                />
                {credits.data.lots.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-1" data-testid="credit-lots">
                    {credits.data.lots.map((lot) => (
                      <li key={lot.id} className="text-fg-2 flex justify-between text-xs">
                        <span className="capitalize">{lot.source}</span>
                        <span>
                          {lot.remainingTenths / 10} left
                          {lot.expiresAt === null ? "" : ` · expires ${formatDate(lot.expiresAt)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Card>

          {streakEnabled ? <StreakWidget /> : null}
        </div>
      </div>

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === "cancel"
                ? "Cancel your subscription?"
                : "Pause your subscription?"}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === "cancel"
                ? "You keep access until the end of the current period, then the plan reverts to Free. This does not delete anything you have made."
                : "Skips one billing cycle — no charge, no credits, until you resume. You can pause once every 12 months."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmAction(null);
              }}
            >
              Never mind
            </Button>
            <Button
              variant="danger"
              disabled={cancel.isPending || pause.isPending}
              data-testid="confirm-subscription-action"
              onClick={() => {
                if (confirmAction !== null) runAction(confirmAction);
              }}
            >
              {confirmAction === "cancel" ? "Cancel subscription" : "Pause subscription"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!upgradeOpen ? null : (
        <CheckoutSheet
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
          selection={{ planKey: "creator", interval: "month" }}
          onSuccess={() => {
            void subscription.refetch();
            void credits.refetch();
          }}
        />
      )}
    </div>
  );
}

function PlanSummary({
  subscription,
  mandateMethod,
  onUpgrade,
  onCancel,
  onPause,
  onResume,
  busy,
}: {
  readonly subscription: NonNullable<ReturnType<typeof useSubscription>["data"]>;
  readonly mandateMethod: string | undefined;
  readonly onUpgrade: () => void;
  readonly onCancel: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly busy: boolean;
}): React.JSX.Element {
  const renewsVia =
    subscription.mandateId !== null
      ? `renews via ${MANDATE_METHOD_LABEL[mandateMethod ?? "upi_autopay"] ?? "Autopay"} · cap ${formatMoney(
          subscription.listPriceMinor,
          subscription.currency,
        )}`
      : subscription.cancelAtPeriodEnd
        ? "does not auto-renew"
        : "one-time purchase";

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-fg-0 text-lg font-semibold capitalize">{subscription.planKey}</h2>
        <Badge tone={STATUS_TONE[subscription.status] ?? "neutral"}>
          {STATUS_LABEL[subscription.status] ?? subscription.status}
        </Badge>
      </div>
      <p className="text-fg-1 text-sm" data-testid="plan-renewal-summary">
        Renews {formatDate(subscription.currentPeriodEnd)} · {renewsVia}
      </p>
      {subscription.cancelAtPeriodEnd ? (
        <p className="text-warning text-xs">
          Cancels at period end — access continues until {formatDate(subscription.currentPeriodEnd)}
          .
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button variant="primary" size="sm" onClick={onUpgrade} data-testid="overview-upgrade">
          Upgrade
        </Button>
        {subscription.status === "paused" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onResume}>
            Resume
          </Button>
        ) : (
          <>
            {subscription.cancelAtPeriodEnd ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={onResume}>
                Undo cancellation
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onPause}
                  data-testid="pause-subscription"
                >
                  Pause
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onCancel}
                  data-testid="cancel-subscription"
                >
                  Cancel
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
