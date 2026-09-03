"use client";

import * as React from "react";

import { toast, UpgradeGate } from "@montaj/ui";

import { CheckoutSheet } from "./checkout-sheet";

import type { PlanKey } from "@/lib/billing/types";

import { useRuntimeConfig } from "@/components/providers";
import { usePlans } from "@/lib/billing/hooks";
import { formatMoney } from "@/lib/billing/money";

/**
 * The one way a gated control anywhere in the app should show a lock (08 §5:
 * "any locked control shows the plan needed inline ... with a single-click
 * checkout sheet; never a dead end"). Wraps `packages/ui`'s `UpgradeGate`
 * (the lock, the copy, the price) with `CheckoutSheet` (the sheet the click
 * opens) so a work package that needs to gate a control imports one
 * component instead of wiring the two together itself.
 *
 * Usage from any other work package's code:
 * ```tsx
 * import { BillingUpgradeGate } from "@/components/billing/billing-upgrade-gate";
 * <BillingUpgradeGate requiredPlan="creator" feature="Exporting without a watermark" />
 * ```
 */
export function BillingUpgradeGate({
  requiredPlan,
  feature,
  interval = "month",
  onUpgraded,
  children,
  className,
}: {
  readonly requiredPlan: PlanKey;
  readonly feature: string;
  readonly interval?: "month" | "year";
  /** Called once the purchase succeeds — the caller re-checks the entitlement, no reload. */
  readonly onUpgraded?: () => void;
  readonly children?: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  const { razorpayEnabled } = useRuntimeConfig();
  const plans = usePlans();
  const [open, setOpen] = React.useState(false);

  const plan = plans.data?.find((candidate) => candidate.key === requiredPlan);
  const price =
    plan === undefined
      ? undefined
      : // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        `${formatMoney(plan.prices.INR[interval] ?? plan.prices.INR.month, "INR")}/${interval === "year" ? "yr" : "mo"}`;

  return (
    <UpgradeGate
      requiredPlan={requiredPlan}
      feature={feature}
      price={price}
      className={className}
      onUpgrade={() => {
        // Payments unconfigured: keep the lock honest (the feature really is gated)
        // but say who can unlock it instead of opening a sheet that cannot charge.
        if (!razorpayEnabled) {
          toast.info("Payments are not configured in this build", {
            description: "Ask an administrator to grant credits or change your plan.",
          });
          return;
        }
        setOpen(true);
      }}
    >
      {children}
      {!open || !razorpayEnabled ? null : (
        <CheckoutSheet
          open={open}
          onOpenChange={setOpen}
          selection={{ planKey: requiredPlan, interval }}
          onSuccess={onUpgraded}
        />
      )}
    </UpgradeGate>
  );
}
