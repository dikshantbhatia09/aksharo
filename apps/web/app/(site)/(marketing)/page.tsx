import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button } from "@montaj/ui";

import { HomeHero } from "./_components/home-hero";
import { LiveCaptionDemo } from "./_components/live-caption-demo";

import type { Metadata } from "next";

import { AUTH_NAV } from "@/content/site/nav";
import { SOCIAL_PROOF_NOTE, SOCIAL_PROOF_STATS } from "@/content/site/social-proof";
import { VALUE_PROPS } from "@/content/site/value-props";

export const metadata: Metadata = {
  title: `${BRAND.name} — captions, cuts and polish for Indian video creators`,
  description:
    "Hinglish-accurate captions, every word editable, 30+ styles, autocut and zoom passes, and one transparent plan for creators.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${BRAND.name} — captions, cuts and polish for Indian video creators`,
    description:
      "Hinglish-accurate captions, every word editable, 30+ styles, and one transparent plan for creators.",
    url: "/",
    type: "website",
  },
};

export default function HomePage(): React.JSX.Element {
  return (
    <div>
      <section className="mx-auto flex max-w-6xl flex-col items-center gap-10 px-4 pt-12 pb-14 sm:px-6 lg:flex-row lg:items-start lg:gap-16 lg:pt-16">
        <div className="w-full flex-1">
          <HomeHero />
          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {/* The page's one filled primary (DESIGN.md › Components). */}
            <Button variant="primary" size="lg" asChild>
              <Link href={AUTH_NAV.getStarted.href}>Start free, one clean export on us</Link>
            </Button>
            <Button variant="secondary" size="lg" asChild>
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
          <p className="text-fg-2 mt-3 mb-0 text-xs">
            No card required. Your footage never trains anyone&apos;s model.
          </p>
        </div>
        <div className="flex-1">
          <LiveCaptionDemo />
        </div>
      </section>

      {/*
        The one place Shirorekha allows a saturated field: the landing page's
        full-bleed stat band (DESIGN.md › Colour). Everywhere else the grounds
        stay neutral — so this band is `--color-section`, and nothing else on
        the site may be. The figures are the display face (large stat figures
        are one of its three allowed uses).
      */}
      <section className="bg-section" aria-labelledby="social-proof-heading">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <h2 id="social-proof-heading" className="sr-only">
            Where Aksharo stands today
          </h2>
          <dl className="grid gap-8 sm:grid-cols-3">
            {SOCIAL_PROOF_STATS.map((stat) => (
              <div
                key={stat.label}
                className="flex flex-col-reverse gap-1"
                data-testid={`social-proof-${stat.label}`}
              >
                <dt className="text-fg-1 m-0 text-sm">{stat.label}</dt>
                <dd className="font-display text-fg-0 m-0 text-2xl font-semibold tracking-[-0.01em] [font-stretch:92%]">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-fg-1 mt-8 mb-0 max-w-2xl text-sm" data-testid="social-proof-note">
            {SOCIAL_PROOF_NOTE}
          </p>
        </div>
      </section>

      <section
        className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20"
        aria-labelledby="value-props-heading"
      >
        <h2 id="value-props-heading" className="text-fg-0 m-0 max-w-[30ch] text-xl">
          Everything that makes a caption tool worth paying for
        </h2>
        <ol className="mt-8 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {VALUE_PROPS.map((prop, index) => (
            <li
              key={prop.id}
              className="border-border bg-surface flex flex-col gap-2 rounded-md border p-5"
              data-testid={`value-prop-${prop.id}`}
            >
              <span className="text-fg-2 font-mono text-xs" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-fg-0 m-0 text-base leading-snug">{prop.title}</h3>
              <p className="text-fg-2 m-0 text-sm leading-relaxed">{prop.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8">
          <Button variant="secondary" asChild>
            <Link href="/features">See every feature</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6" aria-labelledby="cta-heading">
        <div className="border-border bg-surface flex flex-col gap-3 rounded-lg border p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="flex flex-col gap-2">
            <h2 id="cta-heading" className="text-fg-0 m-0 text-xl">
              Bring your first clip. It is free.
            </h2>
            <p className="text-fg-2 m-0 max-w-[52ch] text-sm">
              One clean export on us — no card required, and your footage is never used to train
              anyone&apos;s AI.
            </p>
          </div>
          {/* Secondary: the hero already carries this page's one primary, and
              this repeats the same action for someone who scrolled. */}
          <Button variant="secondary" size="lg" asChild className="shrink-0">
            <Link href={AUTH_NAV.getStarted.href}>Start free</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
