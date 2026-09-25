"use client";

/**
 * The export-dialog watermark upsell (B04, `08-ux-design-system.md` §5 "Export
 * with watermark"): shown inside the export dialog in place of (or beside) the
 * watermark preview when the decision engine's `POST /projects/{id}/exports`
 * answered `watermarked: true`. In order: use the signup gift (if unused) →
 * buy the ₹9 clean export (Razorpay Checkout) → buy the week pass → "See
 * plans".
 *
 * **Mount point.** The editor's own export dialog is A15/A19's — it had not
 * landed when this work package shipped (orchestrator addendum). This
 * component is deliberately self-contained (it fetches its own eligibility
 * and drives its own checkout) so the dialog only needs to:
 *
 * ```tsx
 * <ExportUpsellPanel
 *   onCleanManifestReady={() => void requestExport(sameParamsAsBefore)}
 * />
 * ```
 *
 * `onCleanManifestReady` fires once a clean path becomes available — after
 * the signup gift, or after Razorpay Checkout succeeds AND the webhook has
 * landed (polled via `useOffersEligibility`, never assumed from the widget's
 * own success callback — THREAT-MODEL: a client can never self-report a
 * payment as done). The caller re-issues the *same* export request; per
 * `exports/decision.ts`, the decision engine now returns a clean manifest —
 * no re-render needed if the browser render has not started yet, otherwise
 * the caller re-runs it. See `apps/api/src/exports/README.md` and this
 * file's own header for the full mechanics.
 *
 * A project over the ₹9/signup-gift 10-minute cap or the browser's own length
 * cap never reaches "watermarked but otherwise clean-eligible" from the API
 * (`decision.ts`'s `cleanEligible`), so this panel does not special-case that
 * — `eligibility.ninePass.eligibleToBuy` and the reasons already cover it.
 */
import { CreditCard, Gift, Sparkles, Zap } from "lucide-react";
import * as React from "react";

import {
  usePassCheckout,
  useOffersEligibility,
  type OffersEligibilityView,
} from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Badge, Button, Card, formatCredits, Skeleton, toast } from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";
import { openRazorpayCheckout } from "@/lib/billing/razorpay";
import { messageForError } from "@/lib/errors";

export interface ExportUpsellPanelProps {
  /** Fired once a clean export path is confirmed available. */
  onCleanManifestReady?: () => void;
  className?: string;
}

/** Minor units to a short amount string, INR/USD (no decimals for whole rupees). */
function formatAmount(minor: number, currency: "INR" | "USD"): string {
  const symbol = currency === "INR" ? "₹" : "$";
  const value = minor / 100;
  return `${symbol}${Number.isInteger(value) ? String(value) : value.toFixed(2)}`;
}

const ELIGIBILITY_POLL_MS = 2_000;
const ELIGIBILITY_POLL_ATTEMPTS = 20; // 40s, generous for a webhook in a dev/CI environment

export function ExportUpsellPanel({
  onCleanManifestReady,
  className,
}: ExportUpsellPanelProps): React.JSX.Element {
  const eligibility = useOffersEligibility();
  const { razorpayEnabled } = useRuntimeConfig();
  const passCheckout = usePassCheckout();
  const [buying, setBuying] = React.useState<"first_export" | "week_pass" | null>(null);
  const readyNotified = React.useRef(false);

  // Once the API reports a clean path is available (signup gift, or a paid
  // and not-yet-redeemed nine-pass), tell the caller exactly once.
  React.useEffect(() => {
    const data = eligibility.data;
    if (data === undefined || readyNotified.current) return;
    if (data.signupGift.available || data.ninePass.available) {
      readyNotified.current = true;
      onCleanManifestReady?.();
    }
  }, [eligibility.data, onCleanManifestReady]);

  async function pollUntilAvailable(): Promise<void> {
    for (let attempt = 0; attempt < ELIGIBILITY_POLL_ATTEMPTS; attempt += 1) {
      const result = await eligibility.refetch();
      if (result.data?.ninePass.available === true) return;
      await new Promise((resolve) => setTimeout(resolve, ELIGIBILITY_POLL_MS));
    }
  }

  async function buyNinePass(): Promise<void> {
    setBuying("first_export");
    try {
      const checkout = await passCheckout.mutateAsync({ kind: "first_export" });
      const outcome = await openRazorpayCheckout({
        key: checkout.keyId,
        amount: checkout.amountMinor,
        currency: checkout.currency,
        name: BRAND.name,
        description: "Clean export, one project",
        order_id: checkout.providerOrderId,
      });
      if (outcome.status === "dismissed") return;
      toast.success("Payment received, finishing up.");
      await pollUntilAvailable();
    } catch (error) {
      toast.error("Could not start the nine-rupee checkout", {
        description: messageForError(error),
      });
    } finally {
      setBuying(null);
    }
  }

  async function buyWeekPass(): Promise<void> {
    setBuying("week_pass");
    try {
      const checkout = await passCheckout.mutateAsync({ kind: "week_pass" });
      const outcome = await openRazorpayCheckout({
        key: checkout.keyId,
        amount: checkout.amountMinor,
        currency: checkout.currency,
        name: BRAND.name,
        description: "7-day week pass",
        order_id: checkout.providerOrderId,
      });
      if (outcome.status === "dismissed") return;
      toast.success("Week pass activating, this can take a moment.");
    } catch (error) {
      toast.error("Could not start the week pass checkout", {
        description: messageForError(error),
      });
    } finally {
      setBuying(null);
    }
  }

  // `isPending` covers two different things in TanStack Query: a genuine
  // in-flight first fetch, and a query that is simply `enabled: false`
  // (no workspace id yet — e.g. this component mounted before the session
  // bootstrap that finishes elsewhere in the tree finished rotating the
  // httpOnly cookie into an access token). Rendering the skeleton for the
  // second case forever, with nothing ever explaining why, is exactly the
  // "stuck loading" bug this comment is here to prevent a repeat of — so it
  // gets its own testid rather than being silently indistinguishable from a
  // real fetch in flight.
  if (eligibility.isError) {
    return (
      <Card className={className} data-testid="export-upsell-error">
        <p className="text-fg-2 text-sm">Could not load offers right now.</p>
        <p className="text-fg-2 mt-1 text-2xs">{messageForError(eligibility.error)}</p>
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          onClick={() => void eligibility.refetch()}
          data-testid="export-upsell-retry"
        >
          Retry
        </Button>
      </Card>
    );
  }
  if (eligibility.fetchStatus === "idle" && eligibility.data === undefined) {
    return (
      <Card className={className} data-testid="export-upsell-no-session">
        <p className="text-fg-2 text-sm">Sign in to see export options.</p>
      </Card>
    );
  }
  if (eligibility.isPending) {
    return <Skeleton className={className ?? "h-32"} data-testid="export-upsell-loading" />;
  }

  const data = eligibility.data;

  // With no payment rail the buy buttons are already hidden — but the rows kept
  // printing their prices, which is a broken offer rather than an offer (F07-B1).
  // The "already available" copy stays: a clean export that is paid for or gifted
  // is true regardless of whether new purchases can be made.
  const ninePassCopy = data.ninePass.available
    ? "Clean export ready, waiting on the next render."
    : razorpayEnabled
      ? `Remove for ${formatAmount(data.ninePass.priceMinor, data.ninePass.currency)} (first export)`
      : "Clean export — ask an administrator for credits";
  const weekPassCopy = data.weekPass.active
    ? "Week pass active, no watermark while it lasts."
    : razorpayEnabled
      ? `${formatAmount(data.weekPass.priceMinor, data.weekPass.currency)} for ${String(
          data.weekPass.days,
        )} days, ${formatCredits(data.weekPass.creditsGrantedTenths)} credits`
      : "Week pass — not available in this build";

  return (
    <Card
      className={["flex flex-col gap-3", className].filter(Boolean).join(" ")}
      data-testid="export-upsell-panel"
    >
      <div className="flex items-center gap-2">
        <Badge tone="warning">Watermarked</Badge>
        <p className="text-fg-2 text-sm">Remove the watermark from this export.</p>
      </div>

      {data.signupGift.available ? (
        <div
          className="border-border flex items-center justify-between gap-2 rounded-md border p-3"
          data-testid="export-upsell-signup-gift"
        >
          <div className="flex items-center gap-2">
            <Gift className="size-4" aria-hidden="true" />
            <span className="text-sm">Your free clean export is ready to use.</span>
          </div>
        </div>
      ) : (
        <div
          className="border-border flex items-center justify-between gap-2 rounded-md border p-3"
          data-testid="export-upsell-nine-pass"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden="true" />
            <span className="text-sm">{ninePassCopy}</span>
          </div>
          {data.ninePass.available || !razorpayEnabled ? null : (
            <Button
              type="button"
              variant="secondary"
              disabled={!data.ninePass.eligibleToBuy || buying !== null}
              onClick={() => void buyNinePass()}
              data-testid="export-upsell-buy-nine-pass"
            >
              {buying === "first_export" ? "Opening checkout…" : "Buy ₹9 clean export"}
            </Button>
          )}
          {data.ninePass.eligibleToBuy || data.ninePass.available ? null : (
            <span className="text-fg-2 text-2xs" data-testid="export-upsell-nine-pass-reason">
              {reasonCopy(data.ninePass.reason)}
            </span>
          )}
        </div>
      )}

      <div
        className="border-border flex items-center justify-between gap-2 rounded-md border p-3"
        data-testid="export-upsell-week-pass"
      >
        <div className="flex items-center gap-2">
          <Zap className="size-4" aria-hidden="true" />
          <span className="text-sm">{weekPassCopy}</span>
        </div>
        {data.weekPass.active || !razorpayEnabled ? null : (
          <Button
            type="button"
            variant="secondary"
            disabled={buying !== null}
            onClick={() => void buyWeekPass()}
            data-testid="export-upsell-buy-week-pass"
          >
            {buying === "week_pass" ? "Opening checkout…" : "Get the week pass"}
          </Button>
        )}
      </div>

      {razorpayEnabled ? null : (
        <p className="text-fg-2 text-2xs" data-testid="export-upsell-free-stack">
          Payments are not configured in this build. Ask an administrator to grant credits to remove
          the watermark.
        </p>
      )}

      {/*
        From inside the core journey the marketing price list is a dead end when
        nothing can be bought, so it goes with the rail rather than pointing at
        prices that do not apply to this build (F07-B2).
      */}
      {razorpayEnabled ? (
        <a
          href="/pricing"
          className="text-accent-300 hover:text-accent-200 flex items-center gap-1 self-start rounded-sm text-sm underline underline-offset-2"
          data-testid="export-upsell-see-plans"
        >
          <CreditCard className="size-4" aria-hidden="true" />
          See plans
        </a>
      ) : null}
    </Card>
  );
}

function reasonCopy(reason: OffersEligibilityView["ninePass"]["reason"]): string {
  switch (reason) {
    case "currency_not_inr":
      return "The nine-rupee clean export is INR only.";
    case "on_paid_plan":
      return "Already included on your plan.";
    case "purchased_within_30_days":
      return "One nine-rupee clean export per account every 30 days.";
    default:
      return "";
  }
}
