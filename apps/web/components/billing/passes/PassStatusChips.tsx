"use client";

/**
 * Pass status chips for the Subscription overview (B04 brief §2: "pass status
 * chips in Subscription overview (expiry, credits left)"). Reads `GET
 * /offers/passes` and renders one chip per pass, newest first.
 *
 * **Mount point.** `app/(app)/settings/subscription/subscription-view.tsx`
 * (this work package's own addition — no Subscription overview page existed
 * before B04) renders `<PassStatusChips />` directly beneath the plan
 * summary; any later work package that rebuilds that page can keep this
 * component and drop it in the same place.
 */
import * as React from "react";

import { useOffersPasses, type PassStatus, type PassView } from "@montaj/api-client";
import { Badge, Skeleton, formatCredits } from "@montaj/ui";

const STATUS_LABEL: Record<PassStatus, string> = {
  pending_payment: "Awaiting payment",
  available: "Ready to use",
  active: "Active",
  redeemed: "Used",
  expired: "Expired",
};

const STATUS_TONE: Record<PassStatus, "accent" | "warning" | "neutral" | "rejected"> = {
  pending_payment: "warning",
  available: "accent",
  active: "accent",
  redeemed: "neutral",
  expired: "rejected",
};

const KIND_LABEL: Record<PassView["kind"], string> = {
  first_export: "₹9 clean export",
  week_pass: "Week pass",
  pay_once: "Pay-once",
  topup: "Top-up",
};

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}

export function PassStatusChips(): React.JSX.Element {
  const passes = useOffersPasses();

  if (passes.isPending) {
    return <Skeleton className="h-16" data-testid="pass-chips-loading" />;
  }
  const items = passes.data ?? [];
  if (items.length === 0) {
    return (
      <p className="text-fg-2 text-sm" data-testid="pass-chips-empty">
        No passes bought yet.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2" data-testid="pass-status-chips">
      {items.map((pass) => (
        <Badge key={pass.id} tone={STATUS_TONE[pass.status]} data-testid={`pass-chip-${pass.id}`}>
          {KIND_LABEL[pass.kind]} · {STATUS_LABEL[pass.status]}
          {pass.endsAt !== null ? ` · until ${formatShortDate(pass.endsAt)}` : ""}
          {pass.creditsGrantedTenths > 0
            ? ` · ${formatCredits(pass.creditsGrantedTenths)} credits`
            : ""}
        </Badge>
      ))}
    </div>
  );
}
