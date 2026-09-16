"use client";

import Link from "next/link";
import * as React from "react";

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@montaj/ui";

import { CheckoutSheet } from "./checkout-sheet";
import { CreditsBuyCard } from "./credits-buy-card";
import { FreeStackBillingNotice } from "./free-stack-notice";
import { PlanTable } from "./plan-table";
import { UsagePanel } from "./usage-panel";

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

  // Same flag key the sidebar chip (`shell/sidebar.tsx`) and `streak-chip.tsx`
  // read — this was `"streak.enabled"`, a key nothing ever sets, which is why
  // the widget never mounted on `/billing` (Gate B run 3/4: "widget missing").
  const streakEnabled = config.flags["growth.streakWidget"] === true;

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

  const grantTenths = credits.data?.monthlyGrantTenths ?? 0;
  const balanceTenths = credits.data?.balanceTenths ?? 0;
  const creditsPct =
    grantTenths > 0 ? Math.min(100, Math.max(0, (balanceTenths / grantTenths) * 100)) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="billing-overview">
      {config.razorpayEnabled ? null : <FreeStackBillingNotice />}

      {/*
        Band 1 of the canvas's billing screen: the plan, the balance, and what
        the balance buys — three equal cards, `auto-fit` so they stack rather
        than squeeze.
      */}
      <section className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        <div
          className="bg-surface flex flex-col gap-2.5 rounded-md p-[18px] shadow-[var(--shadow-sm)]"
          data-testid="plan-card"
        >
          {subscription.isPending ? (
            <p className="text-neutral-500 text-sm">Loading your plan…</p>
          ) : subscription.data === null || subscription.data === undefined ? (
            <>
              <span className="text-accent text-[10px] tracking-[0.12em] uppercase">Your plan</span>
              <h2 className="font-display m-0 text-[25px] tracking-[-0.02em]">Free</h2>
              <p className="text-neutral-400 m-0 text-[13px]">
                20 credits a month and one watermark-free export.
              </p>
              {config.razorpayEnabled ? (
                <Button variant="primary" asChild className="mt-auto self-start">
                  <Link href="/billing/plans">See plans</Link>
                </Button>
              ) : null}
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
              paymentsEnabled={config.razorpayEnabled}
            />
          )}
        </div>

        <div className="bg-surface flex flex-col gap-[11px] rounded-md p-[18px]" data-testid="credits-card">
          <span className="text-neutral-500 text-[10px] tracking-[0.12em] uppercase">Credits</span>
          {credits.isPending ? (
            <p className="text-neutral-500 text-sm">Loading credits…</p>
          ) : credits.data === undefined ? (
            <p className="text-neutral-500 text-sm">{messageForError(credits.error)}</p>
          ) : (
            <>
              <div className="flex items-end gap-[7px]">
                <span
                  className="font-display text-[34px] leading-none tracking-[-0.02em] tabular-nums"
                  data-testid="credit-balance"
                >
                  {Math.round(balanceTenths / 10)}
                </span>
                <span className="text-neutral-400 pb-1 text-xs">
                  {
                    // A workspace can carry an admin "adjustment" lot on top
                    // of its monthly grant (the lots list just below draws
                    // these as separate "grant" and "adjust" entries), and
                    // `balanceTenths` sums every lot -- so once one of those
                    // exists the balance can exceed the grant, and "N of
                    // {grant} left" reads as a broken counter the moment N >
                    // grant. Same fix as `this-month-card.tsx`: drop the
                    // denominator rather than let the balance appear to lie.
                    grantTenths > 0 && balanceTenths <= grantTenths
                      ? `of ${String(Math.round(grantTenths / 10))} left`
                      : "credits left"
                  }
                </span>
              </div>

              {creditsPct === null ? null : (
                <span className="bg-neutral-800 block h-[3px] overflow-hidden rounded-full">
                  <span className="bg-accent block h-full" style={{ width: `${String(creditsPct)}%` }} />
                </span>
              )}

              <p className="text-neutral-400 m-0 text-xs">
                {credits.data.grantResetAt === null
                  ? "This balance does not reset on a schedule."
                  : `Your monthly credits refill on ${formatDate(credits.data.grantResetAt)}.`}
              </p>

              {credits.data.lots.length > 0 ? (
                <ul className="m-0 flex flex-col gap-1" data-testid="credit-lots">
                  {credits.data.lots.map((lot) => (
                    <li key={lot.id} className="text-neutral-500 flex justify-between text-xs">
                      <span className="capitalize">{lot.source}</span>
                      <span>
                        {lot.remainingTenths / 10} left
                        {lot.expiresAt === null ? "" : ` · expires ${formatDate(lot.expiresAt)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {config.razorpayEnabled ? (
                <Button variant="primary" size="sm" asChild className="mt-auto self-start">
                  <Link href="/billing/plans">Top up</Link>
                </Button>
              ) : null}
            </>
          )}
        </div>

        <CreditsBuyCard grantTenths={grantTenths} />
      </section>

      {streakEnabled ? <StreakWidget /> : null}

      {/*
        Bands 2 and 3 — "Move up or down" and "Where the credits went". The
        canvas puts all three on one screen; `/billing/plans` and
        `/billing/usage` keep their own routes so a deep link still lands
        somewhere, and the tab strip above still switches between them.
      */}
      {/*
        Nothing to move to without a payment rail: `PlanTable` answers with
        the same "credits are granted by your admin" notice this page already
        shows at the top, and two copies of it is worse than one.
      */}
      {config.razorpayEnabled ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-display m-0 text-[17px] tracking-[-0.01em]">Move up or down</h2>
          <PlanTable />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="font-display m-0 text-[17px] tracking-[-0.01em]">
          Where the credits went
        </h2>
        <UsagePanel />
      </section>

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

      {!config.razorpayEnabled || !upgradeOpen ? null : (
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
  paymentsEnabled,
}: {
  readonly subscription: NonNullable<ReturnType<typeof useSubscription>["data"]>;
  readonly mandateMethod: string | undefined;
  readonly onUpgrade: () => void;
  readonly onCancel: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly busy: boolean;
  readonly paymentsEnabled: boolean;
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
      <div className="flex items-center gap-[9px]">
        <span className="text-accent text-[10px] tracking-[0.12em] uppercase">Your plan</span>
        <Badge tone={STATUS_TONE[subscription.status] ?? "neutral"} className="ml-auto">
          {STATUS_LABEL[subscription.status] ?? subscription.status}
        </Badge>
      </div>
      <h2 className="font-display m-0 text-[25px] tracking-[-0.02em] capitalize">
        {subscription.planKey}
      </h2>
      <p className="text-neutral-400 m-0 text-[13px]" data-testid="plan-renewal-summary">
        Renews {formatDate(subscription.currentPeriodEnd)} · {renewsVia}
      </p>
      {subscription.cancelAtPeriodEnd ? (
        <p className="text-warning m-0 text-xs">
          Cancels at period end — access continues until {formatDate(subscription.currentPeriodEnd)}
          .
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {paymentsEnabled ? (
          <Button variant="primary" size="sm" onClick={onUpgrade} data-testid="overview-upgrade">
            Change plan
          </Button>
        ) : null}
        {/* Invoices is one of the tabs the rail gate hides (F07-C1); its
            shortcut has to go with it or it is a link to nothing. */}
        {paymentsEnabled ? (
          <Button variant="secondary" size="sm" asChild data-testid="billing-history-shortcut">
            <Link href="/billing/invoices">Invoices</Link>
          </Button>
        ) : null}
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
