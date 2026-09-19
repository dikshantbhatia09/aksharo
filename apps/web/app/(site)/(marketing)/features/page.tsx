import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button } from "@montaj/ui";

import type { Metadata } from "next";

import { WER_ROWS, WER_TARGET_NOTE } from "@/content/site/accuracy";
import { AUTH_NAV } from "@/content/site/nav";
import { VALUE_PROPS } from "@/content/site/value-props";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Every value proposition, explained: measured Hinglish accuracy, word-level editing, 30+ styles, autocut and zoom passes, subtitle exports and India-first pricing.",
  alternates: { canonical: "/features" },
  openGraph: {
    title: `Features — ${BRAND.name}`,
    description:
      "Measured Hinglish accuracy, word-level editing, autocut and zoom, and subtitle exports.",
    url: "/features",
    type: "website",
  },
};

export default function FeaturesPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          What {BRAND.name} actually does
        </h1>
        <p className="text-fg-1 mt-4 text-lg">
          Every value proposition in the order we make them, with the detail behind each one.
        </p>
      </header>

      <div className="mt-16 flex flex-col gap-16">
        {VALUE_PROPS.map((prop, index) => (
          <section
            key={prop.id}
            id={prop.id}
            aria-labelledby={`${prop.id}-heading`}
            data-testid={`feature-section-${prop.id}`}
            className="border-border grid gap-4 border-t pt-10 sm:grid-cols-[auto_1fr]"
          >
            <span className="text-lime-500 font-mono text-2xl">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <h2 id={`${prop.id}-heading`} className="text-fg-0 text-2xl font-semibold">
                {prop.title}
              </h2>
              <p className="text-fg-1 mt-3 max-w-2xl leading-relaxed">{prop.body}</p>

              {prop.id === "accuracy" ? (
                <div className="mt-6 overflow-x-auto" data-testid="wer-table">
                  <table className="w-full min-w-[420px] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-border border-b">
                        <th scope="col" className="text-fg-2 py-2 pr-4 font-medium">
                          Language
                        </th>
                        <th scope="col" className="text-fg-2 px-4 py-2 font-medium">
                          Target (public eval set)
                        </th>
                        <th scope="col" className="text-fg-2 px-4 py-2 font-medium">
                          Measured
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {WER_ROWS.map((row) => (
                        <tr key={row.language} className="border-border border-b last:border-0">
                          <th scope="row" className="text-fg-1 py-2 pr-4 font-normal">
                            {row.language}
                          </th>
                          <td className="text-fg-1 px-4 py-2">{row.targetWer}</td>
                          <td className="text-fg-2 px-4 py-2 italic">
                            {row.measuredWer ?? "measured on our public eval set — publishing soon"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-fg-2 mt-3 text-xs">{WER_TARGET_NOTE}</p>
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-16 flex justify-center gap-3">
        <Button variant="primary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
        </Button>
        <Button variant="outline" size="lg" asChild>
          <Link href="/styles">See the styles gallery</Link>
        </Button>
      </div>
    </div>
  );
}
