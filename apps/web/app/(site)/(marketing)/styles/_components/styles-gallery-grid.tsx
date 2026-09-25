"use client";

/**
 * The public styles gallery: the pickable system styles, hover-to-animate, filtered
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
import { Button, Input } from "@montaj/ui";

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
        <Input
          type="search"
          value={query}
          placeholder="Search styles"
          aria-label="Search caption styles"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="bg-sunken sm:w-64"
          data-testid="styles-gallery-search"
        />
        <div
          role="group"
          aria-label="Preview script"
          className="border-border inline-flex shrink-0 gap-0.5 self-start rounded-sm border p-0.5 sm:self-auto"
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
                  ? "bg-neutral-100/14 text-fg-0 h-8 rounded-[4px] px-3 text-xs font-medium"
                  : "text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0 h-8 rounded-[4px] px-3 text-xs font-medium"
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
              "h-8 rounded-full border px-3 text-xs font-medium capitalize transition-colors",
              category === entry
                ? "border-fg-2 bg-neutral-100/14 text-fg-0"
                : "border-border text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0",
            )}
          >
            {entry}
          </button>
        ))}
      </div>

      <p className="text-fg-2 mt-4 text-sm" data-testid="styles-gallery-count" aria-live="polite">
        {visible.length} of {styles.length} {styles.length === 1 ? "style" : "styles"}
      </p>

      {visible.length === 0 ? (
        <div
          className="border-border mt-4 flex flex-col items-start gap-3 rounded-md border border-dashed p-6"
          data-testid="styles-gallery-empty"
        >
          <p className="text-fg-0 text-base font-semibold">No styles match</p>
          <p className="text-fg-2 text-sm">
            {query.trim() === ""
              ? "Nothing in this category yet."
              : `Nothing matches “${query}” in ${category === "all" ? "any category" : category}.`}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setQuery("");
              setCategory("all");
            }}
          >
            Clear search and filters
          </Button>
        </div>
      ) : null}

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
            className="border-border bg-surface overflow-hidden rounded-md border"
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
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-fg-0 truncate text-sm font-medium">{style.name}</span>
              <span className="text-fg-2 shrink-0 text-2xs capitalize">{style.category}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
