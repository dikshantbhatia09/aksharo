import { BRAND } from "@montaj/config";
import { Card } from "@montaj/ui";

import { PlatformBanner } from "./_components/platform-detector";

import type { Metadata } from "next";

import { PLATFORM_BUILDS, PUBLISHER_NAME } from "@/content/site/download-data";

export const metadata: Metadata = {
  title: "Download",
  description: `Download ${BRAND.name} Desktop for Windows, macOS and Linux.`,
  alternates: { canonical: "/download" },
  openGraph: {
    title: `Download — ${BRAND.name}`,
    description: `${BRAND.name} Desktop for Windows, macOS and Linux.`,
    url: "/download",
    type: "website",
  },
};

export default function DownloadPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <header className="text-center">
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          {BRAND.name} Desktop
        </h1>
        <p className="text-fg-1 mt-4 text-lg">
          A native local engine for on-device transcription, audio clean and render — for
          zero-upload workflows and offline-friendly projects.
        </p>
        <p className="text-fg-2 mt-2 text-sm">
          Published by <span data-testid="publisher-name">{PUBLISHER_NAME}</span>
        </p>
      </header>

      <PlatformBanner />

      <div className="mt-12 grid gap-6 sm:grid-cols-3">
        {PLATFORM_BUILDS.map((build) => (
          <Card
            key={build.platform}
            id={build.platform}
            className="flex flex-col gap-3"
            data-testid={`download-card-${build.platform}`}
          >
            <h2 className="text-fg-0 text-lg font-semibold">{build.label}</h2>
            <p className="text-fg-2 text-xs">{build.fileNote}</p>
            <p
              className="border-border text-fg-2 rounded-md border px-3 py-2 text-xs"
              data-testid={`download-placeholder-${build.platform}`}
            >
              Download link placeholder — the signed installer ships with C10.
            </p>
            <div>
              <h3 className="text-fg-0 text-sm font-medium">{build.firstRunTitle}</h3>
              <ol className="text-fg-1 mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-xs">
                {build.firstRunSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p
                className="text-fg-2 mt-3 text-xs italic"
                data-testid={`download-screenshot-placeholder-${build.platform}`}
              >
                Screenshot placeholder — first-run dialog capture pending a signed build.
              </p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
