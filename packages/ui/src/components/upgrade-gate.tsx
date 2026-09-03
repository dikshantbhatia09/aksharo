"use client";

import { Lock } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/cn";
import { Button } from "../primitives/button";

/** The plan ladder of `04-pricing-and-monetization.md`, cheapest first. */
export const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  creator: "Creator",
  pro: "Pro",
  studio: "Studio",
  agency: "Agency",
};

export interface UpgradeGateProps {
  /** `requiredPlan` from the `entitlement/upgrade_required` error envelope. */
  requiredPlan: string;
  /** What the user was trying to do, in their words: "Export without a watermark". */
  feature: string;
  /** Formatted price of the required plan, e.g. "₹699/mo". Optional until B01. */
  price?: string;
  /**
   * Opens the checkout sheet. B03 owns the sheet itself; the gate only owns the
   * lock, the plan name and the single click that starts checkout — 08 §5 says
   * a gate is never a dead end.
   */
  onUpgrade?: () => void;
  /** Rendered inside the gate, below the copy — B03 mounts its sheet here. */
  children?: React.ReactNode;
  className?: string;
}

export function UpgradeGate({
  requiredPlan,
  feature,
  price,
  onUpgrade,
  children,
  className,
}: UpgradeGateProps): React.JSX.Element {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const planName = PLAN_LABEL[requiredPlan] ?? requiredPlan;
  return (
    <div
      className={cn(
        "border-border bg-bg-1 flex flex-col gap-3 rounded-md border border-dashed p-4",
        className,
      )}
      data-testid="upgrade-gate"
      data-required-plan={requiredPlan}
    >
      <p className="text-fg-0 flex items-center gap-2 text-sm font-medium">
        <Lock className="text-fg-2 size-4" aria-hidden="true" />
        {feature} is on {planName}
        {price === undefined ? "" : ` · ${price}`}
      </p>
      <p className="text-fg-2 text-xs">
        Your plan does not include this yet. Upgrading takes about a minute and keeps everything you
        have already made.
      </p>
      {onUpgrade === undefined ? null : (
        <Button variant="primary" size="sm" className="self-start" onClick={onUpgrade}>
          Upgrade to {planName}
        </Button>
      )}
      {children}
    </div>
  );
}
