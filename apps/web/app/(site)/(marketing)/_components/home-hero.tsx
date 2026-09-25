"use client";

/**
 * The hero headline and subheads, English by default with a Hindi toggle
 * (`content/site/hero-copy.ts` — see that file for why this is a small local
 * formatter rather than `next-intl`).
 *
 * Shirorekha: the hero is the home page's title, so it is a `PageHeader` at
 * `size="lg"` — the one shirorekha bar on the page, in the display face. The
 * `hero-headline` test id and the `lang` attribute live on a span inside the
 * `<h1>` so the headline element keeps both while `PageHeader` owns the
 * heading itself.
 *
 * The language switch is a segmented control: a neutral selected segment, not
 * an accent fill (DESIGN.md › Accent budget), and 32 px tall so it meets the
 * pointer hit-target floor.
 */

import { useState } from "react";

import { PageHeader } from "@montaj/ui";

import { heroCopy, HERO_LOCALE_LABEL, type HeroLocale } from "@/content/site/hero-copy";
import { cn } from "@/lib/utils";

export function HomeHero(): React.JSX.Element {
  const [locale, setLocale] = useState<HeroLocale>("en");
  const copy = heroCopy(locale);

  return (
    <div>
      <div
        role="group"
        aria-label="Headline language"
        className="border-border mb-6 inline-flex gap-0.5 rounded-sm border p-0.5"
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
            className={cn(
              "h-8 min-w-16 rounded-[4px] px-3 text-xs font-medium transition-colors",
              locale === option
                ? "bg-neutral-100/14 text-fg-0"
                : "text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0",
            )}
          >
            {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
            {HERO_LOCALE_LABEL[option]}
          </button>
        ))}
      </div>

      <PageHeader
        size="lg"
        eyebrow={
          <span data-testid="hero-kicker" lang={locale}>
            {copy.kicker}
          </span>
        }
        title={
          <span data-testid="hero-headline" lang={locale} className="block max-w-[22ch]">
            {copy.headline}
          </span>
        }
      />

      <div className="mt-5 flex flex-col gap-2" lang={locale}>
        {copy.subheads.map((line) => (
          <p key={line} className="text-fg-1 m-0 max-w-[54ch] text-base leading-relaxed">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
