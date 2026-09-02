"use client";

/**
 * INR default, USD toggle (A24 brief: "INR default with USD toggle by
 * locale").
 *
 * The default is always INR — a browser's reported locale is a weak signal
 * for billing currency (an NRI or an India-based visitor with an
 * `en-US`-configured browser both read as "not India"), and "INR default"
 * only holds if every first paint actually shows INR. A visitor's own choice
 * is what "by locale" means in practice — they pick their currency once and
 * it is remembered in `localStorage` for the next visit.
 *
 * This is a client-side, best-effort default only: the real, contractual
 * currency lock happens server-side at checkout from the workspace's billing
 * country (07 §Workspaces, `workspaces.billing_country`), which is out of
 * scope here (B03 owns checkout).
 */

import { useEffect, useState } from "react";

import type { Currency } from "@/content/site/pricing-data";

const STORAGE_KEY = "aksharo:pricing-currency";

export function useCurrency(): [Currency, (next: Currency) => void] {
  const [currency, setCurrency] = useState<Currency>("INR");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "INR" || stored === "USD") setCurrency(stored);
    } catch {
      // Private browsing or storage blocked: INR (the initial state) stands.
    }
  }, []);

  const set = (next: Currency): void => {
    setCurrency(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best effort; the in-memory state still updates for this visit.
    }
  };

  return [currency, set];
}

export function CurrencyToggle({
  currency,
  onChange,
}: {
  readonly currency: Currency;
  readonly onChange: (currency: Currency) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Currency"
      className="border-border inline-flex rounded-full border p-0.5"
      data-testid="currency-toggle"
    >
      {(["INR", "USD"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={currency === option}
          onClick={() => {
            onChange(option);
          }}
          data-testid={`currency-toggle-${option}`}
          className={
            currency === option
              ? "bg-lime-500 text-on-accent rounded-full px-3 py-1 text-xs font-semibold"
              : "text-fg-1 rounded-full px-3 py-1 text-xs font-semibold"
          }
        >
          {option === "INR" ? "₹ INR" : "$ USD"}
        </button>
      ))}
    </div>
  );
}
