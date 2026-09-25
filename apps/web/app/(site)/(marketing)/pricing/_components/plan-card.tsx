"use client";

import { Check } from "lucide-react";
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
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const price = plan.prices[currency];
  const amount = interval === "year" ? Math.round(price.year / 12) : price.month;
  const isFree = price.month === 0;

  return (
    <Card
      className={cn(
        "flex flex-col gap-4",
        // The recommended plan is marked by its badge and by carrying the
        // pricing page's one primary button — not by an accent ring, which
        // means "selected" in this system (DESIGN.md › Components).
        plan.mostPopular && "border-neutral-600",
      )}
      data-testid={`plan-card-${plan.key}`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-fg-0 text-lg">{plan.name}</h3>
        {plan.mostPopular ? <Badge tone="neutral">Most popular</Badge> : null}
      </div>
      <p className="text-fg-2 text-sm">{plan.tagline}</p>

      <div>
        <span
          className="font-display text-fg-0 text-2xl font-semibold [font-stretch:92%]"
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
            <Check
              aria-hidden="true"
              className="text-fg-2 mt-0.5 size-4 shrink-0"
              strokeWidth={1.75}
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <Button variant={plan.mostPopular ? "primary" : "secondary"} asChild>
        <Link href={AUTH_NAV.getStarted.href}>{plan.ctaLabel}</Link>
      </Button>
    </Card>
  );
}
