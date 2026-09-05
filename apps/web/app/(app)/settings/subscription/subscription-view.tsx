"use client";

/**
 * Subscription overview (B04 brief §2): the plan, pass status chips (expiry,
 * credits left) and the ₹149 top-up. No Subscription page existed before this
 * work package — `08-ux-design-system.md`'s Settings list names it, A13/A16
 * had not built it yet, so it is added here alongside the pieces that need
 * it, in the same place the design system's page inventory puts it.
 *
 * Pay-once selection (brief §2, "pay-once selection in the checkout sheet")
 * belongs to the plan checkout sheet, which — like the export dialog — has
 * not landed from A15/A19/A22 at the time of this work package; `POST
 * /billing/checkout {interval:"once"}` (B01) is what it should call once that
 * sheet exists. Noted here rather than guessed at with a placeholder UI.
 */
import * as React from "react";

import { useSubscription } from "@montaj/api-client";
import { Badge, Card, Skeleton } from "@montaj/ui";

import { PassStatusChips } from "@/components/billing/passes/PassStatusChips";
import { TopupCard } from "@/components/billing/passes/TopupCard";
import { useRuntimeConfig } from "@/components/providers";
import { SettingsSection } from "@/components/settings/section";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  creator: "Creator",
  studio: "Studio",
  agency: "Agency",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function SubscriptionView(): React.JSX.Element {
  const subscription = useSubscription();
  const { razorpayEnabled } = useRuntimeConfig();

  return (
    <SettingsSection
      title="Subscription"
      description="Your plan, passes and top-ups."
      testId="settings-subscription"
    >
      <Card className="flex flex-col gap-2" data-testid="subscription-plan-card">
        {subscription.isPending ? (
          <Skeleton className="h-16" />
        ) : subscription.data === null || subscription.data === undefined ? (
          <>
            <p className="text-fg-0 text-sm font-medium">Free</p>
            <p className="text-fg-2 text-sm">No paid plan on file.</p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="text-fg-0 text-sm font-medium">
                {PLAN_LABEL[subscription.data.planKey] ?? subscription.data.planKey}
              </p>
              <Badge tone={subscription.data.status === "active" ? "accent" : "warning"}>
                {subscription.data.status}
              </Badge>
              {subscription.data.interval === "once" ? (
                <Badge tone="neutral" data-testid="subscription-pay-once-badge">
                  Pay-once
                </Badge>
              ) : null}
            </div>
            <p className="text-fg-2 text-sm">
              Renews {formatDate(subscription.data.currentPeriodEnd)}
              {subscription.data.cancelAtPeriodEnd ? " · cancels at period end" : ""}
            </p>
          </>
        )}
      </Card>

      <div className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-medium">Passes</h2>
        <PassStatusChips />
      </div>

      <div className="flex flex-col gap-2">
        {/* With no payment rail `TopupCard` renders the admin-credits notice, so
            a "Top up" heading would title a section that cannot top anything up. */}
        <h2 className="text-fg-0 text-base font-medium">
          {razorpayEnabled ? "Top up" : "Credits"}
        </h2>
        <TopupCard />
      </div>
    </SettingsSection>
  );
}
