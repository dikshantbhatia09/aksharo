"use client";

import Link from "next/link";

import { Badge, Button, Card } from "@montaj/ui";

import { AUTH_NAV } from "@/content/site/nav";
import { type Currency, formatPrice, type PlanCatalogueEntry } from "@/content/site/pricing-data";
import { cn } from "@/lib/utils";

export interface PlanCardProps {
  readonly plan: PlanCatalogueEntry;
  readonly currency: Currency;
  readonly interval: "month" | "year";
}

export function PlanCard({ plan, currency, interval }: PlanCardProps): React.JSX.Element {
  const price = plan.prices[currency];
  const amount = interval === "year" ? Math.round(price.year / 12) : price.month;
  const isFree = price.month === 0;

  return (
    <Card
      className={cn(
        "flex flex-col gap-4",
        plan.mostPopular && "border-lime-500 ring-lime-500/30 ring-1",
      )}
      data-testid={`plan-card-${plan.key}`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-fg-0 text-lg font-semibold">{plan.name}</h3>
        {plan.mostPopular ? <Badge tone="accent">Most popular</Badge> : null}
      </div>
      <p className="text-fg-2 text-sm">{plan.tagline}</p>

      <div>
        <span
          className="text-fg-0 text-3xl font-semibold"
          data-testid={`plan-card-${plan.key}-price`}
        >
          {isFree ? formatPrice(0, currency) : formatPrice(amount, currency)}
        </span>
        {isFree ? null : <span className="text-fg-2 text-sm"> / month</span>}
        {interval === "year" && !isFree ? (
          <p className="text-fg-2 mt-1 text-xs">
            Billed {formatPrice(price.year, currency)} yearly — 2 months free.
            {plan.key === "studio" && currency === "INR" ? (
              <>
                {" "}
                Over UPI Autopay: two half-yearly debits of{" "}
                {formatPrice(price.halfyear ?? 0, currency)} (₹15,000 mandate cap — see FAQ).
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      <ul className="flex flex-1 flex-col gap-2 text-sm">
        {plan.highlights.map((line) => (
          <li key={line} className="text-fg-1 flex gap-2">
            <span aria-hidden="true" className="text-lime-500">
              +
            </span>
            {line}
          </li>
        ))}
      </ul>

      <Button variant={plan.mostPopular ? "primary" : "outline"} asChild>
        <Link href={AUTH_NAV.getStarted.href}>{plan.ctaLabel}</Link>
      </Button>
    </Card>
  );
}
