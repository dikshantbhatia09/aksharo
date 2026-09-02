"use client";

/**
 * The hero headline and subheads, English by default with a Hindi toggle
 * (`content/site/hero-copy.ts` — see that file for why this is a small local
 * formatter rather than `next-intl`).
 */

import { useState } from "react";

import { heroCopy, HERO_LOCALE_LABEL, type HeroLocale } from "@/content/site/hero-copy";

export function HomeHero(): React.JSX.Element {
  const [locale, setLocale] = useState<HeroLocale>("en");
  const copy = heroCopy(locale);

  return (
    <div>
      <div className="flex items-center gap-3">
        <p className="text-fg-2 text-sm font-medium" data-testid="hero-kicker">
          {copy.kicker}
        </p>
        <div
          role="group"
          aria-label="Headline language"
          className="border-border inline-flex rounded-full border p-0.5"
        >
          {(["en", "hi"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={locale === option}
              onClick={() => {
                setLocale(option);
              }}
              data-testid={`hero-locale-${option}`}
              className={
                locale === option
                  ? "bg-lime-500 text-on-accent rounded-full px-2.5 py-0.5 text-xs font-semibold"
                  : "text-fg-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
              }
            >
              {HERO_LOCALE_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      <h1
        className="font-display text-fg-0 mt-4 text-4xl font-semibold tracking-tight sm:text-5xl"
        data-testid="hero-headline"
        lang={locale}
      >
        {copy.headline}
      </h1>

      <div className="mt-6 flex flex-col gap-3" lang={locale}>
        {copy.subheads.map((line) => (
          <p key={line} className="text-fg-1 text-lg leading-relaxed">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
