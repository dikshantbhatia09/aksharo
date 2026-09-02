"use client";

/**
 * The ₹149/100-credit top-up card (B04 brief §2: "₹149 top-up card in the
 * credits meter when balance < 20"). `packages/ui`'s `CreditMeter` already
 * exposes an `onTopUp` callback for exactly this — this component is the
 * thing that callback should open.
 *
 * **Mount point.** Nothing in the live shell renders `CreditMeter` with real
 * data yet (`components/shell/top-bar.tsx` has no credits meter wired in as
 * of this work package — confirmed by grep, reported as an open question).
 * Until that lands, compose it like this:
 *
 * ```tsx
 * const credits = useWorkspaceCredits();
 * const [topupOpen, setTopupOpen] = useState(false);
 * <CreditMeter
 *   remainingTenths={credits.data?.balanceTenths ?? 0}
 *   includedTenths={credits.data?.monthlyGrantTenths ?? 0}
 *   onTopUp={() => setTopupOpen(true)}
 * />
 * {topupOpen ? <TopupCard onDone={() => setTopupOpen(false)} /> : null}
 * ```
 *
 * The card only offers the ₹149/100-credit pack (the one 04 §Offers allows on
 * Free); larger packs need Starter+ and belong to whatever component ends up
 * owning the full top-up picker.
 */
import * as React from "react";

import { useOffersEligibility, useTopupCheckout } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Card, Skeleton, toast } from "@montaj/ui";

import { openRazorpayCheckout } from "@/lib/billing/razorpay";
import { messageForError } from "@/lib/errors";

export interface TopupCardProps {
  onDone?: () => void;
  className?: string;
}

function formatAmount(minor: number, currency: "INR" | "USD"): string {
  const symbol = currency === "INR" ? "₹" : "$";
  const value = minor / 100;
  return `${symbol}${Number.isInteger(value) ? String(value) : value.toFixed(2)}`;
}

export function TopupCard({ onDone, className }: TopupCardProps): React.JSX.Element {
  const eligibility = useOffersEligibility();
  const topupCheckout = useTopupCheckout();
  const [buying, setBuying] = React.useState(false);

  async function buy(): Promise<void> {
    const tier = eligibility.data?.topupFree149;
    if (tier === undefined) return;
    setBuying(true);
    try {
      const checkout = await topupCheckout.mutateAsync({ credits: tier.credits });
      const outcome = await openRazorpayCheckout({
        key: checkout.keyId,
        amount: checkout.amountMinor,
        currency: checkout.currency,
        name: BRAND.name,
        description: `${String(tier.credits)}-credit top-up`,
        order_id: checkout.providerOrderId,
      });
      if (outcome.status === "success") {
        toast.success("Payment received, credits are on the way.");
        onDone?.();
      }
    } catch (error) {
      toast.error("Could not start the top-up checkout", { description: messageForError(error) });
    } finally {
      setBuying(false);
    }
  }

  if (eligibility.isPending) {
    return <Skeleton className="h-20" data-testid="topup-card-loading" />;
  }
  const tier = eligibility.data?.topupFree149;
  if (tier === undefined || !tier.available) {
    return <></>;
  }

  return (
    <Card className={className} data-testid="topup-card">
      <p className="text-fg-0 text-sm font-medium">
        {formatAmount(tier.priceMinor, tier.currency)} for {tier.credits} credits
      </p>
      <p className="text-fg-2 mt-1 text-2xs">Never expires while your account is active.</p>
      <Button
        type="button"
        variant="secondary"
        className="mt-3"
        disabled={buying}
        onClick={() => void buy()}
        data-testid="topup-card-buy"
      >
        {buying ? "Opening checkout…" : "Top up"}
      </Button>
    </Card>
  );
}
