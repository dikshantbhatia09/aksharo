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
      <section className="mx-auto flex max-w-6xl flex-col items-center gap-[26px] px-4 pt-11 pb-9 sm:px-6 lg:flex-row lg:items-start">
        <div className="flex-1">
          <HomeHero />
          <div className="mt-5 flex flex-col items-start gap-2.5 sm:flex-row sm:items-center">
            <Button variant="primary" size="lg" asChild>
              <Link href={AUTH_NAV.getStarted.href}>Start free, one clean export on us</Link>
            </Button>
            <Button variant="secondary" size="lg" asChild>
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
          <p className="text-neutral-500 mt-3 mb-0 text-[11.5px]">
            No card required. Your footage never trains anyone&apos;s model.
          </p>
        </div>
        <div className="flex-1">
          <LiveCaptionDemo />
        </div>
      </section>

      {/*
        The one place Nocturne allows a saturated field: "the landing
        template's one full-bleed stat band makes the same presence move at
        page scale". Everywhere else the grounds stay desaturated — so this
        band is `--color-section`, and nothing else on the site may be.
      */}
      <section className="bg-section" aria-labelledby="social-proof-heading">
        <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6">
          <h2 id="social-proof-heading" className="sr-only">
            Where Aksharo stands today
          </h2>
          <div className="grid gap-5 sm:grid-cols-3">
            {SOCIAL_PROOF_STATS.map((stat) => (
              <div
                key={stat.label}
                className="flex flex-col gap-1"
                data-testid={`social-proof-${stat.label}`}
              >
                <p className="font-display m-0 text-[25px] tracking-[-0.02em]">{stat.value}</p>
                <p className="text-neutral-200 m-0 text-[12.5px]">{stat.label}</p>
              </div>
            ))}
          </div>
          <p
            className="text-neutral-300 mt-5 mb-0 max-w-2xl text-[12.5px]"
            data-testid="social-proof-note"
          >
            {SOCIAL_PROOF_NOTE}
          </p>
        </div>
      </section>

      <section
        className="mx-auto max-w-6xl px-4 py-20 sm:px-6"
        aria-labelledby="value-props-heading"
      >
        <h2
          id="value-props-heading"
          className="font-display text-fg-0 m-0 max-w-[26ch] text-[27px] tracking-[-0.02em]"
        >
          Everything that makes a caption tool worth paying for
        </h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {VALUE_PROPS.map((prop, index) => (
            <div
              key={prop.id}
              className="flex flex-col gap-[7px]"
              data-testid={`value-prop-${prop.id}`}
            >
              <span className="text-accent font-mono text-xs">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="font-display text-fg-0 m-0 text-[15px] leading-[1.25]">
                {prop.title}
              </h3>
              <p className="text-neutral-400 m-0 text-[12.5px] leading-[1.55]">{prop.body}</p>
            </div>
          ))}
        </div>
        {/* Flush left, like every other heading here: Nocturne is
            left-aligned and asymmetric, with the whitespace on the right. */}
        <div className="mt-10">
          <Button variant="secondary" asChild>
            <Link href="/features">See every feature</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6" aria-labelledby="cta-heading">
        <div className="bg-surface flex flex-col gap-3 rounded-lg p-[26px]">
          <h2
            id="cta-heading"
            className="font-display text-fg-0 m-0 text-[23px] tracking-[-0.02em]"
          >
            Bring your first clip. It is free.
          </h2>
          <p className="text-neutral-400 m-0 max-w-[52ch] text-[13.5px]">
            One clean export on us — no card required, and your footage is never used to train
            anyone&apos;s AI.
          </p>
          <div className="mt-1 flex gap-2">
            <Button variant="primary" asChild>
              <Link href={AUTH_NAV.getStarted.href}>Start free</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
