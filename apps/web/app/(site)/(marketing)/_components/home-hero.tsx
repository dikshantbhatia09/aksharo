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
        <p className="text-neutral-400 m-0 text-[11px]" data-testid="hero-kicker">
          {copy.kicker}
        </p>
        <div
          role="group"
          aria-label="Headline language"
          className="border-border inline-flex gap-[3px] rounded-sm border p-[2px]"
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
                // Nocturne's segmented control: the selected option is an
                // accent *tint*, never an accent fill. See `button.tsx`.
                locale === option
                  ? "bg-accent/16 text-accent-200 rounded-[6px] px-2.5 py-1 text-[11.5px]"
                  : "text-neutral-500 hover:text-neutral-300 rounded-[6px] px-2.5 py-1 text-[11.5px]"
              }
            >
              {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
              {HERO_LOCALE_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      <h1
        className="font-display text-fg-0 mt-4 max-w-[22ch] text-[34px] leading-[1.08] tracking-[-0.025em] sm:text-[40px]"
        data-testid="hero-headline"
        lang={locale}
      >
        {copy.headline}
      </h1>

      <div className="mt-5 flex flex-col gap-[9px]" lang={locale}>
        {copy.subheads.map((line) => (
          <p key={line} className="text-neutral-300 m-0 max-w-[54ch] text-[14.5px] leading-[1.55]">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
