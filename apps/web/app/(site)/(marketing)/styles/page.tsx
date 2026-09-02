import { BRAND } from "@montaj/config";

import { StylesGalleryGrid } from "./_components/styles-gallery-grid";

import type { Metadata } from "next";

import { SYSTEM_STYLES } from "@/components/editor/panels/system-styles";

export const metadata: Metadata = {
  title: "Styles gallery",
  description:
    "All 30+ Aksharo caption styles, filterable by category and preview script, hover to animate.",
  alternates: { canonical: "/styles" },
  openGraph: {
    title: `Caption styles — ${BRAND.name}`,
    description: "30+ caption styles, hover to animate, filterable by category and script.",
    url: "/styles",
    type: "website",
  },
};

export default function StylesPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          30+ styles, every word tunable
        </h1>
        <p className="text-fg-1 mt-4 text-lg">
          Hover a tile to see it animate — this is the real renderer, the same one your export uses.
        </p>
      </header>

      <div className="mt-12">
        <StylesGalleryGrid styles={SYSTEM_STYLES} />
      </div>
    </div>
  );
}
