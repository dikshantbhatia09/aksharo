"use client";

/**
 * The Style tab: a grid of live tiles, each one the actual renderer drawing the
 * actual style. Categories and a search box narrow it; hovering a tile plays
 * its three-second preview.
 *
 * Picking a tile emits one `SetStyle` (CONTRACTS §2) at the current scope — the
 * document, or the selected segment.
 */

import { useMemo, useState } from "react";

import type { StyleCategory, StyleDoc } from "@montaj/caption-styles";

import { type PanelScope, setStyleRef, type SetStyleOp } from "./ops";
import { type CanvasSize, fitPreview } from "../canvas/stage-fit";
import { StylePreviewCanvas } from "../canvas/StylePreviewCanvas";

import { cn } from "@/lib/utils";

/**
 * FIX-05: the fallback document shape for the two call sites that have no project
 * in scope (`StyleGallery`'s dev harness and `style-quick-pick`'s sheet). 9:16 is
 * the product's dominant format and matches the portrait tile these previews drew
 * before, so nothing regresses where a real canvas cannot be known.
 */
export const DEFAULT_PREVIEW_CANVAS: CanvasSize = { width: 1080, height: 1920 };

export interface StylePickerProps {
  readonly styles: readonly StyleDoc[];
  readonly selectedStyleId?: string;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  /**
   * "Save as template" — K01 wires this to a client-local "My Presets" store
   * (`my-presets.ts`) rather than a new API route (wave README golden-rule
   * addendum). The panel builds the name prompt and serialises the current
   * style; the caller (`editor-client.tsx`) owns where it's persisted.
   */
  readonly onSaveTemplate?: () => void;
  /**
   * The workspace's own saved presets (K01), shown in a second "My Presets"
   * sub-tab next to the built-in catalogue when provided. Omitted entirely —
   * not just empty — hides that sub-tab, so the two other callers of this
   * component (`StyleGallery`'s dev harness, `style-quick-pick`'s sheet, both
   * of which have no project/preset context) render exactly as before.
   */
  readonly myPresets?: readonly StyleDoc[];
  /** Removes one saved preset; only meaningful alongside `myPresets`. */
  readonly onDeletePreset?: (id: string) => void;
  /** The document's canvas, so each tile previews in the project's real aspect. */
  readonly canvas?: CanvasSize;
  readonly className?: string;
}

/** Case- and punctuation-insensitive match on the name, id and category. */
export function matchesQuery(style: StyleDoc, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${style.name} ${style.id} ${style.category}`.toLowerCase().includes(needle);
}

/** The categories actually present, in the order the catalogue lists them. */
export function categoriesOf(styles: readonly StyleDoc[]): StyleCategory[] {
  const seen: StyleCategory[] = [];
  for (const style of styles) if (!seen.includes(style.category)) seen.push(style.category);
  return seen;
}

export function StylePicker({
  styles,
  selectedStyleId,
  scope,
  onOp,
  onSaveTemplate,
  myPresets,
  onDeletePreset,
  canvas = DEFAULT_PREVIEW_CANVAS,
  className,
}: StylePickerProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StyleCategory | "all">("all");
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<"builtin" | "mine">("builtin");
  const showMyPresets = myPresets !== undefined;
  const onMine = showMyPresets && source === "mine";

  // FIX-05: a definite, aspect-correct tile size. `auto-rows-max` on the grid
  // stops Chromium squeezing every row to fit a definite-height flex child (the
  // ~7px slivers the audit found); this gives the row something real to size to.
  // 132×168 keeps two columns inside the 320px panel for 16:9 and 9:16 alike.
  const preview = useMemo(() => fitPreview(canvas, 132, 168), [canvas]);

  const categories = useMemo(() => categoriesOf(styles), [styles]);
  const visible = useMemo(() => {
    // My Presets is a flat, personal list — no category shelf to file it under.
    if (onMine) return (myPresets ?? []).filter((style) => matchesQuery(style, query));
    return styles.filter(
      (style) => (category === "all" || style.category === category) && matchesQuery(style, query),
    );
  }, [onMine, myPresets, styles, category, query]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-3", className)} data-testid="style-picker">
      {showMyPresets ? (
        <div className="flex gap-1" role="tablist" aria-label="Style source">
          <button
            type="button"
            role="tab"
            aria-selected={source === "builtin"}
            onClick={() => {
              setSource("builtin");
            }}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs",
              source === "builtin" ? "bg-white text-black" : "bg-white/10 text-white/80",
            )}
            data-testid="style-picker-source-builtin"
          >
            Built-in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "mine"}
            onClick={() => {
              setSource("mine");
            }}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs",
              source === "mine" ? "bg-white text-black" : "bg-white/10 text-white/80",
            )}
            data-testid="style-picker-source-mine"
          >
            My Presets ({myPresets?.length ?? 0})
          </button>
        </div>
      ) : null}

      <input
        type="search"
        value={query}
        placeholder={onMine ? "Search my presets" : "Search styles"}
        aria-label={onMine ? "Search my presets" : "Search caption styles"}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm"
        data-testid="style-picker-search"
      />

      {onMine ? null : (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Style categories">
          {(["all", ...categories] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={category === entry}
              onClick={() => {
                setCategory(entry);
              }}
              className={cn(
                "rounded-full px-3 py-1 text-xs capitalize",
                category === entry ? "bg-white text-black" : "bg-white/10 text-white/80",
              )}
              data-testid={`style-picker-category-${entry}`}
            >
              {entry}
            </button>
          ))}
        </div>
      )}

      {onMine && visible.length === 0 ? (
        <p className="px-1 text-xs text-white/50" data-testid="style-picker-empty-mine">
          {(myPresets?.length ?? 0) === 0
            ? "Nothing saved yet — pick a look and use “Save as template” below."
            : "No saved preset matches that search."}
        </p>
      ) : null}

      <div
        className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto content-start"
        data-testid="style-picker-grid"
      >
        {visible.map((style) => (
          <div key={style.id} className="relative">
            <button
              type="button"
              aria-pressed={style.id === selectedStyleId}
              onClick={() => {
                onOp(setStyleRef(scope, style.id));
              }}
              onPointerEnter={() => {
                setHovered(style.id);
              }}
              onPointerLeave={() => {
                setHovered((current) => (current === style.id ? undefined : current));
              }}
              className={cn(
                "w-full overflow-hidden rounded-lg border text-left",
                style.id === selectedStyleId ? "border-sky-400" : "border-white/10",
              )}
              data-testid={`style-picker-tile-${style.id}`}
            >
              <StylePreviewCanvas
                style={style}
                {...preview}
                playing={hovered === style.id}
                className="mx-auto"
              />
              <span className="block truncate px-2 py-1 text-xs">{style.name}</span>
            </button>
            {onMine && onDeletePreset !== undefined ? (
              <button
                type="button"
                aria-label={`Delete ${style.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDeletePreset(style.id);
                }}
                className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white/80 hover:bg-black/80"
                data-testid={`style-picker-delete-${style.id}`}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {onSaveTemplate === undefined ? null : (
        <button
          type="button"
          onClick={onSaveTemplate}
          className="rounded-md bg-white/10 px-3 py-2 text-sm"
          data-testid="style-picker-save-template"
        >
          Save as template
        </button>
      )}
    </div>
  );
}
