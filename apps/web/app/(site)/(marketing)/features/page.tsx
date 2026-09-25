import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button, PageHeader } from "@montaj/ui";

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
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        size="lg"
        title={<>What {BRAND.name} actually does</>}
        description="Every value proposition in the order we make them, with the detail behind each one."
      />

      <nav aria-label="On this page" className="mt-8">
        <ol className="flex list-none flex-wrap gap-2 p-0">
          {VALUE_PROPS.map((prop) => (
            <li key={prop.id}>
              <a
                href={`#${prop.id}`}
                className="border-border text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0 inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium no-underline"
              >
                {prop.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-12 flex flex-col">
        {VALUE_PROPS.map((prop, index) => (
          <section
            key={prop.id}
            id={prop.id}
            aria-labelledby={`${prop.id}-heading`}
            data-testid={`feature-section-${prop.id}`}
            className="border-border grid scroll-mt-24 gap-3 border-t py-10 sm:grid-cols-[3rem_1fr] sm:gap-6"
          >
            <span className="text-fg-2 font-mono text-sm sm:pt-1.5" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <h2 id={`${prop.id}-heading`} className="text-fg-0 text-xl">
                {prop.title}
              </h2>
              <p className="text-fg-1 mt-3 max-w-2xl text-base leading-relaxed">{prop.body}</p>

              {prop.id === "accuracy" ? (
                <div
                  className="border-border bg-surface mt-6 overflow-x-auto rounded-md border px-5 py-3"
                  data-testid="wer-table"
                >
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
                          <td className="text-fg-2 px-4 py-2">
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

      <div className="border-border flex flex-col items-start gap-3 border-t pt-10 sm:flex-row sm:items-center">
        <Button variant="primary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
        </Button>
        <Button variant="secondary" size="lg" asChild>
          <Link href="/styles">See the styles gallery</Link>
        </Button>
      </div>
    </div>
  );
}
