import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

import { StylesGalleryGrid } from "./_components/styles-gallery-grid";

import type { Metadata } from "next";

import { PICKABLE_STYLES } from "@/components/editor/panels/system-styles";

export const metadata: Metadata = {
  title: "Styles gallery",
  description:
    "Aksharo's caption style: bold, word-by-word, every value tunable. Hover to animate.",
  alternates: { canonical: "/styles" },
  openGraph: {
    title: `Caption styles — ${BRAND.name}`,
    description: "Aksharo's caption style, drawn by the real renderer. Hover to animate.",
    url: "/styles",
    type: "website",
  },
};

export default function StylesPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        size="lg"
        title="One bold style, every word tunable"
        description="Hover a tile to see it animate — this is the real renderer, the same one your export uses."
      />

      <div className="mt-10">
        <StylesGalleryGrid styles={PICKABLE_STYLES} />
      </div>
    </div>
  );
}
