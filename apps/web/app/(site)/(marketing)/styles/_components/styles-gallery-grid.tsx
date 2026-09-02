"use client";

/**
 * The public styles gallery: all 30 system styles, hover-to-animate, filtered
 * by category and by preview script. Built for a signed-out visitor rather than
 * reusing `apps/web/components/editor/panels/StylePicker.tsx` directly — that
 * component emits `SetStyle` editor ops and a plan-gated "Save as template"
 * button that make no sense here — but it reuses the same
 * `StylePreviewCanvas` primitive that component and `/studio/styles` already
 * ship, so the pixels are the same real renderer output either place.
 */

import { useMemo, useState } from "react";

import type { StyleCategory, StyleDoc } from "@montaj/caption-styles";
import type { WordScript } from "@montaj/render-core";

import { StylePreviewCanvas } from "@/components/editor/canvas/StylePreviewCanvas";
import { categoriesOf, matchesQuery } from "@/components/editor/panels/StylePicker";
import { cn } from "@/lib/utils";

const SCRIPTS: readonly { readonly id: WordScript; readonly label: string }[] = [
  { id: "latin", label: "Roman" },
  { id: "devanagari", label: "Devanagari" },
  { id: "tamil", label: "Tamil" },
];

export function StylesGalleryGrid({
  styles,
}: {
  readonly styles: readonly StyleDoc[];
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StyleCategory | "all">("all");
  const [script, setScript] = useState<WordScript>("latin");
  const [hovered, setHovered] = useState<string | undefined>(undefined);

  const categories = useMemo(() => categoriesOf(styles), [styles]);
  const visible = useMemo(
    () =>
      styles.filter(
        (style) =>
          (category === "all" || style.category === category) && matchesQuery(style, query),
      ),
    [styles, category, query],
  );

  return (
    <div data-testid="styles-gallery">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          value={query}
          placeholder="Search styles"
          aria-label="Search caption styles"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="border-border bg-bg-1 text-fg-0 w-full rounded-md border px-3 py-2 text-sm sm:w-64"
          data-testid="styles-gallery-search"
        />
        <div
          role="group"
          aria-label="Preview script"
          className="border-border inline-flex shrink-0 rounded-full border p-0.5"
        >
          {SCRIPTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={script === entry.id}
              onClick={() => {
                setScript(entry.id);
              }}
              data-testid={`styles-gallery-script-${entry.id}`}
              className={
                script === entry.id
                  ? "bg-lime-500 text-on-accent rounded-full px-3 py-1 text-xs font-semibold"
                  : "text-fg-1 rounded-full px-3 py-1 text-xs font-semibold"
              }
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="mt-4 flex flex-wrap gap-2"
        role="tablist"
        aria-label="Style categories"
        data-testid="styles-gallery-categories"
      >
        {(["all", ...categories] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={category === entry}
            onClick={() => {
              setCategory(entry);
            }}
            data-testid={`styles-gallery-category-${entry}`}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium capitalize",
              category === entry ? "bg-lime-500 text-on-accent" : "bg-bg-2 text-fg-1",
            )}
          >
            {entry}
          </button>
        ))}
      </div>

      <p className="text-fg-2 mt-4 text-sm" data-testid="styles-gallery-count">
        {visible.length} of {styles.length} styles
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {visible.map((style) => (
          <div
            key={style.id}
            onPointerEnter={() => {
              setHovered(style.id);
            }}
            onPointerLeave={() => {
              setHovered((current) => (current === style.id ? undefined : current));
            }}
            onFocus={() => {
              setHovered(style.id);
            }}
            onBlur={() => {
              setHovered((current) => (current === style.id ? undefined : current));
            }}
            className="border-border overflow-hidden rounded-lg border"
            data-testid={`styles-gallery-tile-${style.id}`}
          >
            <StylePreviewCanvas
              style={style}
              width={160}
              height={284}
              script={script}
              playing={hovered === style.id}
              className="w-full"
            />
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-fg-0 truncate text-xs font-medium">{style.name}</span>
              <span className="text-fg-2 text-2xs capitalize">{style.category}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
