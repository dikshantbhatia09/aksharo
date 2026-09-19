"use client";

import { useState } from "react";

import { BURN_RATES, CREDIT_OPERATIONS, TENTHS_PER_CREDIT } from "@montaj/config";
import type { BurnRate } from "@montaj/config";

import { CurrencyToggle, useCurrency } from "./currency-toggle";
import { PlanCard } from "./plan-card";
import { PlanMatrix } from "./plan-matrix";

import { useRuntimeConfig } from "@/components/providers";
import { surfaceEnabled } from "@/content/site/launch-surfaces";
import { CREDITS_TO_OUTCOMES, OFFERS, type PlanCatalogueEntry } from "@/content/site/pricing-data";
import { OUR_OBJECTIONS, PAUSE_OBJECTIONS, type FaqEntry } from "@/content/site/pricing-faq";

/**
 * `transcription` → `Transcription`, `autocutPass` → `Autocut Pass`. Done in JS
 * rather than a CSS `capitalize` class: `text-transform` changes what is
 * painted, not the text node itself, so a `toContainText`/`toHaveText`
 * assertion (and a screen reader's text-under-cursor readout) still sees the
 * raw lowercase camelCase string.
 */
function operationLabel(operation: string): string {
  const spaced = operation.replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function FaqList({ entries }: { readonly entries: readonly FaqEntry[] }): React.JSX.Element {
  return (
    <dl className="flex flex-col gap-6">
      {entries.map((entry) => (
        <div key={entry.question} className="border-border border-b pb-6 last:border-0">
          <dt className="text-fg-0 font-semibold">{entry.question}</dt>
          <dd className="text-fg-1 mt-2 text-sm leading-relaxed">{entry.answer}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface PricingContentProps {
  readonly plans: readonly PlanCatalogueEntry[];
  /** Whether `plans` came from the live API or the static fallback (content/site/pricing-live.ts). */
  readonly source: "live" | "fallback";
}

export function PricingContent({ plans, source }: PricingContentProps): React.JSX.Element {
  const { flags } = useRuntimeConfig();
  const [currency, setCurrency] = useCurrency();
  const [interval, setInterval] = useState<"month" | "year">("month");

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6" data-plan-source={source}>
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          Simple, transparent credits
        </h1>
        <p className="text-fg-1 mt-4 text-lg">
          Your creative projects draw from one unified pool of minutes. Start free with one clean
          export on us.
        </p>
        {!surfaceEnabled("checkout", flags) && (
          <div
            className="border-border bg-surface text-fg-1 mx-auto mt-6 max-w-2xl rounded-md border p-4 text-center text-sm"
            data-testid="billing-pilot-notice"
          >
            <p className="font-semibold text-fg-0">
              Direct checkout is currently in private pilot.
            </p>
            <p className="mt-1 text-xs text-fg-2">
              All plans start with free sign-up and include your first clean export. Upgrades are
              available inside your workspace.
            </p>
          </div>
        )}
      </header>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <div
          role="group"
          aria-label="Billing interval"
          className="border-border inline-flex rounded-full border p-0.5"
        >
          {(["month", "year"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={interval === option}
              onClick={() => {
                setInterval(option);
              }}
              data-testid={`interval-toggle-${option}`}
              className={
                interval === option
                  ? "bg-lime-500 text-on-accent rounded-full px-3 py-1 text-xs font-semibold"
                  : "text-fg-1 rounded-full px-3 py-1 text-xs font-semibold"
              }
            >
              {option === "month" ? "Monthly" : "Yearly — 2 months free"}
            </button>
          ))}
        </div>
        <CurrencyToggle currency={currency} onChange={setCurrency} />
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {plans.map((plan) => (
          <PlanCard key={plan.key} plan={plan} currency={currency} interval={interval} />
        ))}
      </div>

      <section className="mt-20" aria-labelledby="offers-heading">
        <h2 id="offers-heading" className="font-display text-fg-0 text-2xl font-semibold">
          Try it before you subscribe
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {OFFERS.map((offer) => (
            <div
              key={offer.key}
              className="border-border rounded-md border p-5"
              data-testid={`offer-${offer.key}`}
            >
              <p className="text-fg-0 text-2xl font-semibold">{offer.priceInr}</p>
              <p className="text-fg-2 text-xs">
                {offer.priceUsd === "INR only" ? "INR only" : `${offer.priceUsd} outside India`}
              </p>
              <h3 className="text-fg-0 mt-2 font-medium">{offer.title}</h3>
              <p className="text-fg-1 mt-1 text-sm">{offer.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20" aria-labelledby="outcomes-heading">
        <h2 id="outcomes-heading" className="font-display text-fg-0 text-2xl font-semibold">
          Credits to outcomes
        </h2>
        <p className="text-fg-1 mt-2 max-w-2xl text-sm">
          1 credit = transcribing 1 minute of media in the cloud. Browser-native exports cost 0
          credits on all plans.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table
            className="w-full min-w-[520px] border-collapse text-left text-sm"
            data-testid="outcomes-table"
          >
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="text-fg-2 py-3 pr-4 font-medium">
                  Plan
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  Credits / month
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  ≈ Transcription
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  ≈ Reels
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  ≈ Podcast episodes
                </th>
              </tr>
            </thead>
            <tbody>
              {CREDITS_TO_OUTCOMES.map((row) => (
                <tr key={row.credits} className="border-border border-b last:border-0">
                  <th scope="row" className="text-fg-1 py-3 pr-4 font-normal">
                    {row.plan}
                  </th>
                  <td className="text-fg-1 px-4 py-3">{row.credits}</td>
                  <td className="text-fg-1 px-4 py-3">{row.transcriptionHours}</td>
                  <td className="text-fg-1 px-4 py-3">{row.reels}</td>
                  <td className="text-fg-1 px-4 py-3">{row.podcastEpisodes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-fg-2 mt-3 text-xs">
          The Creator row is quoted directly from the pricing model; Starter and Studio scale the
          same ratios and are marked "about".
        </p>
      </section>

      <section className="mt-20" aria-labelledby="burn-rate-heading">
        <h2 id="burn-rate-heading" className="font-display text-fg-0 text-2xl font-semibold">
          Burn rates
        </h2>
        <p className="text-fg-1 mt-2 max-w-2xl text-sm">
          Every operation, published. Time is rounded up to the nearest 0.1 minute.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table
            className="w-full min-w-[640px] border-collapse text-left text-sm"
            data-testid="burn-rate-table"
          >
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="text-fg-2 py-3 pr-4 font-medium">
                  Operation
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  Credits
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  Basis
                </th>
                <th scope="col" className="text-fg-2 px-4 py-3 font-medium">
                  Note
                </th>
              </tr>
            </thead>
            <tbody>
              {CREDIT_OPERATIONS.map((operation) => {
                // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
                const rate: BurnRate = BURN_RATES[operation];
                const credits = rate.ratePerUnitTenths / TENTHS_PER_CREDIT;
                const pro =
                  rate.proRatePerUnitTenths === undefined
                    ? ""
                    : ` (Pro engine: ${String(rate.proRatePerUnitTenths / TENTHS_PER_CREDIT)})`;
                return (
                  <tr key={operation} className="border-border border-b last:border-0">
                    <th scope="row" className="text-fg-1 py-3 pr-4 font-normal">
                      {operationLabel(operation)}
                    </th>
                    <td className="text-fg-1 px-4 py-3">
                      {credits}
                      {pro}
                    </td>
                    <td className="text-fg-1 px-4 py-3">{rate.basis}</td>
                    <td className="text-fg-2 px-4 py-3 text-xs">{rate.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-20" aria-labelledby="matrix-heading">
        <h2 id="matrix-heading" className="font-display text-fg-0 text-2xl font-semibold">
          Compare every plan
        </h2>
        <div className="mt-6">
          <PlanMatrix plans={plans} />
        </div>
      </section>

      <section className="mt-20 grid gap-12 lg:grid-cols-2" aria-labelledby="faq-heading">
        <div>
          <h2 id="faq-heading" className="font-display text-fg-0 text-2xl font-semibold">
            The questions everyone asks
          </h2>
          <p className="text-fg-1 mt-2 text-sm">
            The same questions Pause&apos;s own FAQ asks — answered against what we actually built.
          </p>
          <div className="mt-6">
            <FaqList entries={PAUSE_OBJECTIONS} />
          </div>
        </div>
        <div>
          <h2 className="font-display text-fg-0 text-2xl font-semibold">Payments in India</h2>
          <p className="text-fg-1 mt-2 text-sm">
            Privacy, mandates, refunds, GST and the ₹15,000 UPI rule, plainly.
          </p>
          <div className="mt-6">
            <FaqList entries={OUR_OBJECTIONS} />
          </div>
        </div>
      </section>
    </div>
  );
}
