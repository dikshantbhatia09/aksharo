"use client";

import * as React from "react";

import { Badge, Button, Card, toast } from "@montaj/ui";

import { CheckoutSheet } from "./checkout-sheet";

import type { CheckoutSelection } from "@/lib/billing/checkout-state";
import type { PlanKey, PlanView } from "@/lib/billing/types";

import {
  usePassCheckout,
  usePlans,
  useSubscription,
  useTopupCheckout,
  useWorkspaceBilling,
} from "@/lib/billing/hooks";
import { estimateSeatedTotalMinor, formatMoney, monthlyEquivalentMinor } from "@/lib/billing/money";
import { openRazorpayCheckout } from "@/lib/billing/razorpay";
import { messageForError } from "@/lib/errors";

const PLAN_TAGLINE: Record<PlanKey, string> = {
  free: "Try it, one clean export included",
  starter: "Local mode, English translation",
  creator: "The plan most people land on",
  studio: "Team seats, the Pro engine, SFX & music",
  agency: "Client separation, per-seat pooled credits",
};

const PLAN_HIGHLIGHTS: Record<PlanKey, readonly string[]> = {
  free: ["20 credits/month", "1080p browser export", "30+ styles"],
  starter: ["150 credits/month", "Local desktop transcription", "English translation"],
  creator: ["500 credits/month", "4K export", "Autocut & Reframe/Zoom", "All languages"],
  studio: ["1,800 credits/month", "3 seats included", "Pro engine, SFX/Music", "API access"],
  agency: ["900 pooled credits/seat", "Client tags & GSTIN invoices", "Per-seat billing"],
};

const ONCE_ELIGIBLE: ReadonlySet<PlanKey> = new Set(["starter", "creator"]);

export function PlanTable(): React.JSX.Element {
  const plans = usePlans();
  const billing = useWorkspaceBilling();
  const subscription = useSubscription();
  const [billingInterval, setBillingInterval] = React.useState<"month" | "year">("month");
  const [payOnce, setPayOnce] = React.useState(false);
  const [seats, setSeats] = React.useState(1);
  const [sheetSelection, setSheetSelection] = React.useState<CheckoutSelection | null>(null);

  const currency = billing.data?.currency ?? "INR";
  const currentPlanKey = subscription.data?.planKey;

  const openCheckout = (planKey: PlanKey): void => {
    const usesOnce = payOnce && ONCE_ELIGIBLE.has(planKey);
    setSheetSelection({
      planKey,
      interval: usesOnce ? "once" : billingInterval,
      ...(planKey === "agency" ? { seats } : {}),
    });
  };

  if (plans.isPending) {
    return (
      <div className="text-fg-2 text-sm" data-testid="plan-table-loading">
        Loading plans…
      </div>
    );
  }

  if (plans.isError || plans.data === undefined) {
    return (
      <div className="text-rejected text-sm" role="alert">
        {messageForError(plans.error)}
      </div>
    );
  }

  const sellablePlans = plans.data.filter((plan) => plan.key !== "free");

  return (
    <div className="flex flex-col gap-10" data-testid="plan-table">
      <div className="flex flex-wrap items-center gap-4">
        <div
          role="group"
          aria-label="Billing interval"
          className="border-border inline-flex rounded-full border p-0.5"
        >
          {(["month", "year"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={billingInterval === option}
              data-testid={`plan-interval-${option}`}
              onClick={() => {
                setBillingInterval(option);
              }}
              className={
                billingInterval === option
                  ? "bg-lime-500 text-on-accent rounded-full px-3 py-1 text-xs font-semibold"
                  : "text-fg-1 rounded-full px-3 py-1 text-xs font-semibold"
              }
            >
              {option === "month" ? "Monthly" : "Yearly — 2 months free"}
            </button>
          ))}
        </div>

        <div
          role="group"
          aria-label="Payment mode"
          className="border-border inline-flex rounded-full border p-0.5"
        >
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={payOnce === value}
              data-testid={value ? "pay-mode-once" : "pay-mode-autopay"}
              onClick={() => {
                setPayOnce(value);
              }}
              className={
                payOnce === value
                  ? "bg-lime-500 text-on-accent rounded-full px-3 py-1 text-xs font-semibold"
                  : "text-fg-1 rounded-full px-3 py-1 text-xs font-semibold"
              }
            >
              {value ? "Pay once" : "UPI Autopay / Card"}
            </button>
          ))}
        </div>
      </div>

      {payOnce ? (
        <p className="text-fg-2 text-xs" data-testid="pay-once-explainer">
          Pay once buys 30 days of Starter or Creator at the monthly price — no mandate, no
          auto-renew. We remind you three days before it expires. Studio and Agency are Autopay or
          Card only.
        </p>
      ) : (
        <p className="text-fg-2 text-xs" data-testid="autopay-explainer">
          UPI Autopay auto-renews with a mandate capped at the plan's list price, never above
          ₹15,000 per debit. Card and eNACH have no such ceiling.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {sellablePlans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            currency={currency}
            interval={billingInterval}
            payOnce={payOnce && ONCE_ELIGIBLE.has(plan.key)}
            payOnceUnavailable={payOnce && !ONCE_ELIGIBLE.has(plan.key)}
            seats={plan.key === "agency" ? seats : undefined}
            onSeatsChange={plan.key === "agency" ? setSeats : undefined}
            isCurrent={currentPlanKey === plan.key}
            onChoose={() => {
              openCheckout(plan.key);
            }}
          />
        ))}
      </div>

      <OffersLadder currency={currency} />
      <CreditsToOutcomes plans={plans.data} />
      <FaqBlock />

      {sheetSelection === null ? null : (
        <CheckoutSheet
          open={sheetSelection !== null}
          onOpenChange={(open) => {
            if (!open) setSheetSelection(null);
          }}
          selection={sheetSelection}
          onSuccess={() => {
            void subscription.refetch();
          }}
        />
      )}
    </div>
  );
}

function PlanCard({
  plan,
  currency,
  interval,
  payOnce,
  payOnceUnavailable,
  seats,
  onSeatsChange,
  isCurrent,
  onChoose,
}: {
  readonly plan: PlanView;
  readonly currency: "INR" | "USD";
  readonly interval: "month" | "year";
  readonly payOnce: boolean;
  readonly payOnceUnavailable: boolean;
  readonly seats?: number;
  readonly onSeatsChange?: (seats: number) => void;
  readonly isCurrent: boolean;
  readonly onChoose: () => void;
}): React.JSX.Element {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const prices = plan.prices[currency];
  const isAgency = plan.key === "agency";
  const effectiveSeats = seats ?? 1;
  const basePrice = payOnce ? prices.month : interval === "year" ? prices.year : prices.month;
  const total = isAgency
    ? estimateSeatedTotalMinor(
        prices.month,
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        plan.seatPrice?.[currency] ?? 0,
        effectiveSeats,
        payOnce ? "once" : interval,
      )
    : basePrice;
  const perMonthDisplay =
    !payOnce && interval === "year" ? monthlyEquivalentMinor(prices) : prices.month;
  const showHalfyearNote =
    !payOnce && interval === "year" && currency === "INR" && plan.hasHalfyear.INR;

  return (
    <Card className="flex flex-col gap-3" data-testid={`plan-card-${plan.key}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-fg-0 text-lg font-semibold">{plan.name}</h3>
        {isCurrent ? <Badge tone="accent">Current plan</Badge> : null}
      </div>
      <p className="text-fg-2 text-sm">{PLAN_TAGLINE[plan.key]}</p>

      <div>
        <span
          className="text-fg-0 text-2xl font-semibold"
          data-testid={`plan-card-${plan.key}-price`}
        >
          {formatMoney(isAgency ? total : perMonthDisplay, currency)}
        </span>
        <span className="text-fg-2 text-sm">
          {" "}
          {isAgency
            ? `for ${String(effectiveSeats)} seat${effectiveSeats === 1 ? "" : "s"}`
            : "/ month"}
        </span>
        {!payOnce && interval === "year" ? (
          <p className="text-fg-2 mt-1 text-xs">
            Billed {formatMoney(isAgency ? total : prices.year, currency)} yearly — 2 months free.
          </p>
        ) : null}
        {showHalfyearNote ? (
          <p className="text-info mt-1 text-xs" data-testid={`plan-card-${plan.key}-halfyear`}>
            Over UPI Autopay: two half-yearly debits of{" "}
            {formatMoney(prices.halfyear ?? 0, currency)} (₹15,000 mandate cap).
          </p>
        ) : null}
      </div>

      {isAgency && onSeatsChange !== undefined ? (
        <div className="flex items-center gap-2">
          <label htmlFor="agency-seats" className="text-fg-1 text-xs">
            Seats
          </label>
          <Button
            variant="outline"
            size="icon"
            aria-label="Fewer seats"
            onClick={() => {
              onSeatsChange(Math.max(1, effectiveSeats - 1));
            }}
          >
            −
          </Button>
          <input
            id="agency-seats"
            type="number"
            min={1}
            max={500}
            value={effectiveSeats}
            data-testid="agency-seats-input"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 1) onSeatsChange(value);
            }}
            className="bg-bg-1 border-border text-fg-0 h-8 w-14 rounded-sm border text-center text-sm"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="More seats"
            onClick={() => {
              onSeatsChange(Math.min(500, effectiveSeats + 1));
            }}
          >
            +
          </Button>
        </div>
      ) : null}

      <ul className="flex flex-1 flex-col gap-1.5 text-sm">
        {PLAN_HIGHLIGHTS[plan.key].map((line) => (
          <li key={line} className="text-fg-1 flex gap-2">
            <span aria-hidden="true" className="text-lime-500">
              +
            </span>
            {line}
          </li>
        ))}
      </ul>

      <Button
        variant={isCurrent ? "outline" : "primary"}
        disabled={isCurrent || payOnceUnavailable}
        data-testid={`plan-card-${plan.key}-choose`}
        onClick={onChoose}
      >
        {isCurrent
          ? "Current plan"
          : payOnceUnavailable
            ? "Pay once unavailable"
            : `Choose ${plan.name}`}
      </Button>
    </Card>
  );
}

function OffersLadder({ currency }: { readonly currency: "INR" | "USD" }): React.JSX.Element {
  const passCheckout = usePassCheckout();
  const topupCheckout = useTopupCheckout();

  const buyPass = (kind: "first_export" | "week_pass"): void => {
    passCheckout.mutate(
      { kind },
      {
        onSuccess: async (response) => {
          try {
            const outcome = await openRazorpayCheckout({
              key: response.keyId,
              amount: response.amountMinor,
              currency: response.currency,
              name: "Aksharo",
              order_id: response.providerOrderId,
            });
            toast[outcome.status === "success" ? "success" : "error"](
              outcome.status === "success" ? "Payment window opened" : "Payment window closed",
              { description: "Credits appear on your account as soon as payment completes." },
            );
          } catch (error) {
            toast.error("Could not open the payment window", {
              description: messageForError(error),
            });
          }
        },
        onError: (error) => {
          toast.error("Could not start that purchase", { description: messageForError(error) });
        },
      },
    );
  };

  const buyTopup = (credits: number): void => {
    topupCheckout.mutate(
      { credits },
      {
        onSuccess: async (response) => {
          try {
            const outcome = await openRazorpayCheckout({
              key: response.keyId,
              amount: response.amountMinor,
              currency: response.currency,
              name: "Aksharo",
              order_id: response.providerOrderId,
            });
            toast[outcome.status === "success" ? "success" : "error"](
              outcome.status === "success" ? "Payment window opened" : "Payment window closed",
              { description: "Credits appear on your account as soon as payment completes." },
            );
          } catch (error) {
            toast.error("Could not open the payment window", {
              description: messageForError(error),
            });
          }
        },
        onError: (error) => {
          toast.error("Could not start that purchase", { description: messageForError(error) });
        },
      },
    );
  };

  const offers = [
    {
      key: "signup-gift",
      title: "Signup gift",
      description: "One watermark-free 1080p browser export, on Free.",
      price: "Included",
      action: null,
    },
    {
      key: "clean-export",
      title: "₹9 clean export",
      description: "One more watermark-free export, no plan needed.",
      price: currency === "INR" ? formatMoney(900, "INR") : "INR only",
      action: () => {
        buyPass("first_export");
      },
    },
    {
      key: "week-pass",
      title: "Week Pass",
      description: "7 days of Starter with 40 credits, no mandate.",
      price: formatMoney(currency === "INR" ? 5_900 : 150, currency),
      action: () => {
        buyPass("week_pass");
      },
    },
    {
      key: "topup",
      title: "100-credit top-up",
      description: "One-time credits, available from Free.",
      price: formatMoney(currency === "INR" ? 14_900 : 300, currency),
      action: () => {
        buyTopup(100);
      },
    },
  ] as const;

  return (
    <section aria-labelledby="offers-heading" className="flex flex-col gap-4">
      <h2 id="offers-heading" className="font-display text-fg-0 text-xl font-semibold">
        Try it before you subscribe
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {offers.map((offer) => (
          <Card key={offer.key} className="flex flex-col gap-2" data-testid={`offer-${offer.key}`}>
            <p className="text-fg-0 text-xl font-semibold">{offer.price}</p>
            <h3 className="text-fg-0 font-medium">{offer.title}</h3>
            <p className="text-fg-1 text-sm">{offer.description}</p>
            {offer.action === null ? null : (
              <Button
                variant="outline"
                size="sm"
                className="mt-auto self-start"
                disabled={passCheckout.isPending || topupCheckout.isPending}
                onClick={offer.action}
              >
                Buy
              </Button>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}

function CreditsToOutcomes({ plans }: { readonly plans: readonly PlanView[] }): React.JSX.Element {
  return (
    <section aria-labelledby="outcomes-heading" className="flex flex-col gap-4">
      <h2 id="outcomes-heading" className="font-display text-fg-0 text-xl font-semibold">
        Credits to outcomes
      </h2>
      <p className="text-fg-2 text-sm">
        1 credit = transcribing 1 minute of media in the cloud. Local desktop transcription costs 0
        credits on Starter and up.
      </p>
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[480px] border-collapse text-left text-sm"
          data-testid="outcomes-table"
        >
          <thead>
            <tr className="border-border border-b">
              <th scope="col" className="text-fg-2 py-2 pr-4 font-medium">
                Plan
              </th>
              <th scope="col" className="text-fg-2 px-4 py-2 font-medium">
                Credits / month
              </th>
              <th scope="col" className="text-fg-2 px-4 py-2 font-medium">
                ≈ Transcription
              </th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.key} className="border-border border-b last:border-0">
                <th scope="row" className="text-fg-1 py-2 pr-4 font-normal">
                  {plan.name}
                </th>
                <td className="text-fg-1 px-4 py-2">{plan.creditsPerMonthTenths / 10}</td>
                <td className="text-fg-1 px-4 py-2">
                  ≈ {(plan.creditsPerMonthTenths / 10 / 60).toFixed(1)} h
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const FAQ_ENTRIES: readonly { readonly question: string; readonly answer: string }[] = [
  {
    question: "What happens above the ₹15,000 UPI Autopay cap?",
    answer:
      "UPI Autopay cannot register a recurring mandate above ₹15,000 — an RBI rule, not ours. Studio yearly is offered as two half-yearly UPI debits, one Card or eNACH charge, or pay-once with a reminder.",
  },
  {
    question: "Can I cancel any time?",
    answer:
      "Yes — monthly plans cancel any time and keep access until the period ends; the first monthly purchase has a 7-day money-back guarantee if fewer than 20 credits were used.",
  },
  {
    question: "Is GST included?",
    answer:
      "Every Indian price shown is inclusive of 18% GST, broken out on the receipt and at checkout.",
  },
  {
    question: "What if a renewal payment fails?",
    answer:
      "You get a 3-day grace period before anything is restricted, plus a card/eNACH/pay-once fallback offered automatically.",
  },
];

function FaqBlock(): React.JSX.Element {
  return (
    <section aria-labelledby="faq-heading" className="flex flex-col gap-4">
      <h2 id="faq-heading" className="font-display text-fg-0 text-xl font-semibold">
        Questions people ask
      </h2>
      <dl className="flex flex-col gap-4">
        {FAQ_ENTRIES.map((entry) => (
          <div key={entry.question} className="border-border border-b pb-4 last:border-0">
            <dt className="text-fg-0 font-medium">{entry.question}</dt>
            <dd className="text-fg-1 mt-1 text-sm">{entry.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
