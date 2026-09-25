"use client";

/**
 * The style catalogue, as the premium canvas draws it: a heading and a
 * preview-script switch, a category shelf with the count on the right, and a
 * grid of portrait tiles — each one the real renderer drawing the real style,
 * playing its three-second loop while the pointer is on it.
 *
 * "Every style renders through the same engine your export uses, so the tile
 * is the result" is the canvas's own claim for this screen, and it is true
 * here: `StylePreviewCanvas` runs `@montaj/render-core` over the same
 * `StyleDoc` the export does. Two consequences worth knowing:
 *
 *  - Under `next dev` the tiles are blank. The CSP deliberately withholds
 *    `'unsafe-eval'` (asserted by `next.config.test.ts`) and CanvasKit needs
 *    it to instantiate; a production build renders them. Do not weaken the
 *    CSP to see the previews.
 *  - The catalogue comes from `GET /styles`, which carries the workspace's own
 *    presets alongside the system ones. Its entries are summaries, not whole
 *    documents, so a tile draws from the bundled `SYSTEM_STYLES` document of
 *    the same id — a workspace preset with no bundled document shows its card
 *    without a rendered preview rather than showing someone else's style.
 */

import * as React from "react";

import { useStyles } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import { PageHeader, cn } from "@montaj/ui";

import { StylePreviewCanvas } from "@/components/editor/canvas/StylePreviewCanvas";
import { PICKABLE_STYLES, SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";


/** The canvas's "Preview script" switch, in the renderer's own vocabulary. */
const SCRIPTS = [
  { key: "latin", label: "Roman" },
  { key: "devanagari", label: "Devanagari" },
  { key: "tamil", label: "Tamil" },
] as const;

type ScriptKey = (typeof SCRIPTS)[number]["key"];

/**
 * One segment of a segmented control. Selection is shown the way the system
 * shows a selected item (a raised well plus the accent ring); hover is the
 * neutral tint. The accent is never spent on hover.
 */
function segment(on: boolean): string {
  return cn(
    "inline-flex h-8 items-center rounded-sm px-3 text-xs font-medium",
    "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
    on
      ? "bg-bg-2 text-fg-0 ring-1 ring-accent"
      : "text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0",
  );
}

/** "all" and the catalogue's lower-case category keys, in sentence case. */
function categoryLabel(key: string): string {
  if (key === "all") return "All";
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]/g, " ");
}

export function StylesView(): React.JSX.Element {
  const catalogue = useStyles();
  const [category, setCategory] = React.useState<string>("all");
  const [script, setScript] = React.useState<ScriptKey>("latin");
  const [hovered, setHovered] = React.useState<string | undefined>(undefined);

  /*
   * The catalogue endpoint is the source of truth for *which* styles this
   * workspace has; the bundled documents are the source of truth for what one
   * looks like. Until the endpoint answers, the bundled system set is a
   * correct (if incomplete) list rather than an empty screen.
   */
  const entries: readonly { id: string; name: string; category: string; doc?: StyleDoc }[] =
    React.useMemo(() => {
      const fromApi = catalogue.data;
      if (fromApi === undefined || fromApi.length === 0) {
        return PICKABLE_STYLES.map((doc) => ({
          id: doc.id,
          name: doc.name,
          category: doc.category,
          doc,
        }));
      }
      return fromApi.map((entry) => {
        const doc = SYSTEM_STYLE_MAP.get(entry.id);
        return {
          id: entry.id,
          name: entry.name,
          category: doc?.category ?? "custom",
          ...(doc === undefined ? {} : { doc }),
        };
      });
    }, [catalogue.data]);

  const categories = React.useMemo(() => {
    const seen: string[] = [];
    for (const entry of entries) if (!seen.includes(entry.category)) seen.push(entry.category);
    return ["all", ...seen];
  }, [entries]);

  const visible = entries.filter((entry) => category === "all" || entry.category === category);

  return (
    <div className="flex flex-col gap-6" data-testid="styles-view">
      <PageHeader
        title={<span data-testid="styles-heading">Styles</span>}
        description="Every style renders through the same engine your export uses, so the tile is the result. Hover or focus a tile to play it."
        actions={
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <span id="styles-preview-script" className="text-xs font-medium text-fg-2">
              Preview script
            </span>
            <div
              className="flex gap-1 rounded-md border border-border bg-sunken p-1"
              role="group"
              aria-labelledby="styles-preview-script"
            >
              {SCRIPTS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={segment(script === entry.key)}
                  aria-pressed={script === entry.key}
                  onClick={() => {
                    setScript(entry.key);
                  }}
                  data-testid={`preview-script-${entry.key}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Style categories">
          {categories.map((key) => (
            <button
              key={key}
              type="button"
              className={segment(category === key)}
              aria-pressed={category === key}
              onClick={() => {
                setCategory(key);
              }}
              data-testid={`style-category-${key}`}
            >
              {categoryLabel(key)}
            </button>
          ))}
        </div>
        <span
          className="ml-auto text-xs text-fg-2 tabular-nums"
          data-testid="style-count"
          aria-live="polite"
        >
          {visible.length === 1 ? "1 style" : `${String(visible.length)} styles`}
        </span>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {visible.map((entry) => (
          <button
            key={entry.id}
            type="button"
            // A tile is a card: hairline border, neutral hover. The accent ring
            // is reserved for a SELECTED card, and this catalogue has no
            // selection, so it never appears here.
            className={cn(
              "flex flex-col overflow-hidden rounded-md border border-border bg-surface text-left",
              "transition-colors duration-[160ms] hover:border-neutral-600",
            )}
            onPointerEnter={() => {
              setHovered(entry.id);
            }}
            onPointerLeave={() => {
              setHovered((current) => (current === entry.id ? undefined : current));
            }}
            onFocus={() => {
              setHovered(entry.id);
            }}
            onBlur={() => {
              setHovered((current) => (current === entry.id ? undefined : current));
            }}
            data-testid={`style-tile-${entry.id}`}
          >
            <span className="bg-sunken flex aspect-[9/13] items-center justify-center overflow-hidden">
              {entry.doc === undefined ? (
                <span className="px-3 text-center text-xs text-fg-2">
                  No preview for this style yet
                </span>
              ) : (
                <StylePreviewCanvas
                  style={entry.doc}
                  width={150}
                  height={217}
                  script={script}
                  playing={hovered === entry.id}
                  label={`${entry.name} preview`}
                  className="h-full w-full"
                />
              )}
            </span>
            <span className="flex flex-col gap-0.5 px-3 pt-2.5 pb-3">
              <span className="truncate text-sm text-fg-0">{entry.name}</span>
              <span className="text-2xs text-fg-2">{categoryLabel(entry.category)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
