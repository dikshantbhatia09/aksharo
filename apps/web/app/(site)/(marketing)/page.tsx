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
  title: "Aksharo — captions, cuts and polish, done inside your timeline",
  description:
    "Hinglish-accurate captions, every word editable, 30+ styles, autocut and zoom passes, and one plan for web, desktop, Premiere Pro, After Effects and DaVinci Resolve.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${BRAND.name} — captions, cuts and polish, done inside your timeline`,
    description:
      "Hinglish-accurate captions, every word editable, 30+ styles, and one plan for web, desktop and every plugin.",
    url: "/",
    type: "website",
  },
};

export default function HomePage(): React.JSX.Element {
  return (
    <div>
      <section className="mx-auto flex max-w-6xl flex-col items-center gap-12 px-4 py-16 sm:px-6 lg:flex-row lg:items-start lg:py-24">
        <div className="flex-1">
          <HomeHero />
          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Button variant="primary" size="lg" asChild>
              <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </div>
        <div className="flex-1">
          <LiveCaptionDemo />
        </div>
      </section>

      <section
        className="border-border border-t border-b bg-[var(--color-bg-1)]"
        aria-labelledby="social-proof-heading"
      >
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <h2 id="social-proof-heading" className="sr-only">
            Where Aksharo stands today
          </h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {SOCIAL_PROOF_STATS.map((stat) => (
              <div key={stat.label} data-testid={`social-proof-${stat.label}`}>
                <p className="text-fg-0 text-2xl font-semibold">{stat.value}</p>
                <p className="text-fg-2 text-sm">{stat.label}</p>
              </div>
            ))}
          </div>
          <p className="text-fg-2 mt-6 max-w-2xl text-sm" data-testid="social-proof-note">
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
          className="font-display text-fg-0 text-3xl font-semibold tracking-tight"
        >
          Everything that makes a caption tool worth paying for
        </h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {VALUE_PROPS.map((prop, index) => (
            <div key={prop.id} data-testid={`value-prop-${prop.id}`}>
              <span className="text-lime-500 text-sm font-mono">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-fg-0 mt-2 font-semibold">{prop.title}</h3>
              <p className="text-fg-1 mt-2 text-sm leading-relaxed">{prop.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 flex justify-center">
          <Button variant="outline" asChild>
            <Link href="/features">See every feature</Link>
          </Button>
        </div>
      </section>

      <section
        className="border-border border-t bg-[var(--color-bg-1)]"
        aria-labelledby="cta-heading"
      >
        <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <h2 id="cta-heading" className="font-display text-fg-0 text-3xl font-semibold">
            Bring your first clip. It is free.
          </h2>
          <p className="text-fg-1 mt-4">
            One clean export on us — no card required, and your footage is never used to train
            anyone&apos;s AI.
          </p>
          <div className="mt-8">
            <Button variant="primary" size="lg" asChild>
              <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
