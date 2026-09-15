"use client";

/**
 * The Style tab: a grid of live tiles, each one the actual renderer drawing the
 * actual style. Categories and a search box narrow it; hovering a tile plays
 * its three-second preview.
 *
 * Picking a tile emits one `SetStyle` (CONTRACTS §2) at the current scope — the
 * document, or the selected segment.
 */

import { Bookmark, BookmarkPlus, Search, Trash2 } from "lucide-react";
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

/**
 * The panel's one-of-N control, copied from `controls.tsx` so the Style tab's
 * source sub-nav and category shelf read as the same family as every other
 * segmented control in the right panel (08 §1: lime only for state that is on).
 */
function segmentedItem(active: boolean): string {
  return cn(
    "h-[26px] rounded-[6px] border px-2.5 text-xs font-medium transition-colors duration-[160ms]",
    active
      ? "border-lime-500/45 bg-lime-500/12 text-lime-500"
      : "text-fg-2 hover:text-fg-0 border-transparent bg-transparent",
  );
}

const SEGMENTED_TRACK = "flex gap-0.5 rounded-sm border border-border bg-bg-0 p-0.5";

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
  const motionKeywords =
    style.animation.typographyMotion === undefined ? "" : "typography motion editorial";
  return `${style.name} ${style.id} ${style.category} ${motionKeywords}`
    .toLowerCase()
    .includes(needle);
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
        <div className={SEGMENTED_TRACK} role="tablist" aria-label="Style source">
          <button
            type="button"
            role="tab"
            aria-selected={source === "builtin"}
            onClick={() => {
              setSource("builtin");
            }}
            className={cn(segmentedItem(source === "builtin"), "flex-1")}
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
            className={cn(segmentedItem(source === "mine"), "flex-1")}
            data-testid="style-picker-source-mine"
          >
            My Presets ({myPresets?.length ?? 0})
          </button>
        </div>
      ) : null}

      <div className="relative">
        <Search
          className="text-fg-2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          placeholder={onMine ? "Search my presets" : "Search styles"}
          aria-label={onMine ? "Search my presets" : "Search caption styles"}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="border-border bg-bg-0 text-fg-0 placeholder:text-fg-2 hover:border-fg-2/60 h-8 w-full rounded-sm border pr-2.5 pl-8 text-xs transition-colors"
          data-testid="style-picker-search"
        />
      </div>

      {onMine ? null : (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Style categories">
          {(["all", ...categories] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={category === entry}
              onClick={() => {
                setCategory(entry);
              }}
              className={cn(segmentedItem(category === entry), "capitalize")}
              data-testid={`style-picker-category-${entry}`}
            >
              {entry}
            </button>
          ))}
        </div>
      )}

      {onMine && visible.length === 0 ? (
        <div
          className="flex flex-col items-center gap-1.5 px-1 py-6 text-center"
          data-testid="style-picker-empty-mine"
        >
          <Bookmark className="text-fg-disabled size-6" aria-hidden="true" />
          <p className="text-fg-1 text-sm">
            {(myPresets?.length ?? 0) === 0
              ? "Nothing saved yet — pick a look and use “Save as template” below."
              : "No saved preset matches that search."}
          </p>
          <p className="text-2xs text-fg-2">
            {(myPresets?.length ?? 0) === 0
              ? "Saved presets stay on this device."
              : "Try a different search term."}
          </p>
        </div>
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
                "bg-bg-0 w-full overflow-hidden rounded-sm border text-left transition-colors duration-[160ms]",
                style.id === selectedStyleId
                  ? "border-lime-500 ring-1 ring-lime-500"
                  : "border-border hover:border-fg-2/60",
              )}
              data-testid={`style-picker-tile-${style.id}`}
            >
              <StylePreviewCanvas
                style={style}
                {...preview}
                {...(style.animation.typographyMotion === undefined
                  ? {}
                  : { background: "#e5a381" })}
                playing={hovered === style.id}
                className="mx-auto"
              />
              <span
                className={cn(
                  "text-2xs block truncate px-2 py-1.5",
                  style.id === selectedStyleId ? "text-fg-0" : "text-fg-1",
                )}
              >
                {style.name}
              </span>
            </button>
            {onMine && onDeletePreset !== undefined ? (
              <button
                type="button"
                aria-label={`Delete ${style.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDeletePreset(style.id);
                }}
                className="text-fg-2 hover:text-rejected bg-bg-1/90 absolute top-1 right-1 flex size-[22px] items-center justify-center rounded-[6px] transition-colors"
                data-testid={`style-picker-delete-${style.id}`}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {onSaveTemplate === undefined ? null : (
        <button
          type="button"
          onClick={onSaveTemplate}
          className="bg-lime-500 hover:bg-lime-600 text-on-accent flex h-8 w-full items-center justify-center gap-2 rounded-sm text-sm font-medium transition-colors duration-[160ms]"
          data-testid="style-picker-save-template"
        >
          <BookmarkPlus className="size-3.5" aria-hidden="true" />
          Save as template
        </button>
      )}
    </div>
  );
}
