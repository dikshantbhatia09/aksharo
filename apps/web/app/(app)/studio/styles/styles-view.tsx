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
import { cn } from "@montaj/ui";

import { StylePreviewCanvas } from "@/components/editor/canvas/StylePreviewCanvas";
import { SYSTEM_STYLE_MAP, SYSTEM_STYLES } from "@/components/editor/panels/system-styles";


/** The canvas's "Preview script" switch, in the renderer's own vocabulary. */
const SCRIPTS = [
  { key: "latin", label: "Roman" },
  { key: "devanagari", label: "Devanagari" },
  { key: "tamil", label: "Tamil" },
] as const;

type ScriptKey = (typeof SCRIPTS)[number]["key"];

function pill(on: boolean): string {
  return cn(
    "rounded-sm border px-2.5 py-[5px] text-[11.5px] capitalize",
    "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
    on
      ? "border-accent bg-accent/14 text-accent-200"
      : "border-border text-neutral-400 hover:border-accent hover:text-neutral-200",
  );
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
        return SYSTEM_STYLES.map((doc) => ({
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
    <div className="flex flex-col gap-3.5" data-testid="styles-view">
      <div className="flex flex-wrap items-end gap-3.5">
        <div className="max-w-[52ch]">
          <h1
            className="font-display m-0 mb-[5px] text-[23px] tracking-[-0.02em]"
            data-testid="styles-heading"
          >
            Styles
          </h1>
          <p className="text-neutral-400 m-0 text-[13px]">
            Every style renders through the same engine your export uses, so the tile is the
            result. Hover to play one.
          </p>
        </div>

        <div className="ml-auto flex flex-col items-end gap-[7px]">
          <span className="text-neutral-500 text-[9.5px] tracking-[0.12em] uppercase">
            Preview script
          </span>
          <div className="flex gap-1.5" role="group" aria-label="Preview script">
            {SCRIPTS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={pill(script === entry.key)}
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
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Style categories">
          {categories.map((key) => (
            <button
              key={key}
              type="button"
              className={pill(category === key)}
              aria-pressed={category === key}
              onClick={() => {
                setCategory(key);
              }}
              data-testid={`style-category-${key}`}
            >
              {key}
            </button>
          ))}
        </div>
        <span className="text-neutral-500 ml-auto text-[11.5px]" data-testid="style-count">
          {String(visible.length)} styles
        </span>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {visible.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={cn(
              "bg-surface flex flex-col overflow-hidden rounded-md text-left",
              "shadow-[0_0_0_1px_var(--color-neutral-900)] transition-shadow duration-[160ms]",
              "hover:shadow-[0_0_0_1px_var(--color-accent)]",
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
                <span className="text-neutral-500 px-3 text-center text-[10.5px]">
                  Preview not bundled
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
            <span className="flex items-baseline justify-between gap-1.5 px-2.5 pt-2 pb-2.5">
              <span className="text-fg-0 text-[11.5px]">{entry.name}</span>
              <span className="text-neutral-500 text-[9.5px] tracking-[0.08em] uppercase">
                {entry.category}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
