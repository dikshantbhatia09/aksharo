"use client";

/**
 * Popular Viral Caption Style Presets Carousel (Pillar 4 §06).
 *
 * Provides a high-retention 1-click viral aesthetic carousel for short-form video creators:
 * - Hormozi Neon Pop: Bold uppercase, neon yellow highlight, heavy black stroke, spring bounce.
 * - MrBeast Comic: Chunky comic display font, multi-color palette rotation, dynamic comic tilt.
 * - Karaoke Cyan: Progressive wipe reveal, muted gray to vivid mint/cyan as spoken.
 * - Editorial Ghost: Sophisticated minimalist typography for executive thought leadership.
 * - Neon Cyber Pulse: Intense neon cyan/magenta aura with futuristic typography.
 *
 * Performance SLA: Preset switch latency <= 50ms with instant CanvasKit/Skia re-render.
 */

import { Check, ChevronLeft, ChevronRight, Sparkles, Zap } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import {
  BUILTIN_PRESETS,
  compilePresetToStyleDoc,
  VIRAL_PRESET_TO_SYSTEM_STYLE,
  type ViralPresetItem,
  type ViralPresetKey,
} from "@montaj/caption-styles/browser";
import type { StyleDoc } from "@montaj/caption-styles";

import { type PanelScope, setStyleRef, type SetStyleOp } from "./panels/ops";
import { SYSTEM_STYLE_MAP } from "./panels/system-styles";
import { type CanvasSize, fitPreview } from "./canvas/stage-fit";
import { StylePreviewCanvas } from "./canvas/StylePreviewCanvas";

import { cn } from "@/lib/utils";

export interface PresetCarouselProps {
  /** The currently selected style id (either a system style like 'punch-pop' or a viral preset key) */
  readonly selectedStyleId?: string;
  /** Panel scope for op emission (default: document scope) */
  readonly scope?: PanelScope;
  /** Called when a user selects a preset, emitting a SetStyleOp */
  readonly onOp?: (op: SetStyleOp) => void;
  /** Callback notifying the parent component of the selected viral preset and compiled StyleDoc */
  readonly onSelectPreset?: (
    key: ViralPresetKey,
    preset: ViralPresetItem,
    compiledDoc: StyleDoc,
  ) => void;
  /** Target canvas dimensions for aspect-ratio matching */
  readonly canvas?: CanvasSize;
  readonly className?: string;
}

export interface PresetMetadata {
  readonly key: ViralPresetKey;
  readonly title: string;
  readonly creatorTag: string;
  readonly badgeText: string;
  readonly description: string;
  readonly accentColor: string;
  readonly systemStyleId: string;
}

export const VIRAL_PRESETS_METADATA: readonly PresetMetadata[] = [
  {
    key: "hormozi_neon",
    title: "Hormozi Neon Pop",
    creatorTag: "The Hormozi Style",
    badgeText: "High Retention",
    description: "Bold uppercase, neon yellow punch, heavy stroke, spring bounce",
    accentColor: "#FEE715",
    systemStyleId: "punch-pop",
  },
  {
    key: "mrbeast_comic",
    title: "MrBeast Comic",
    creatorTag: "The MrBeast Style",
    badgeText: "Punchy Tilt",
    description: "Chunky comic font, rainbow rotation, dynamic bounce & tilt",
    accentColor: "#00E5FF",
    systemStyleId: "hype-bold",
  },
  {
    key: "karaoke_cyan",
    title: "Karaoke Cyan",
    creatorTag: "Progressive Wipe",
    badgeText: "Sing-Along",
    description: "Smooth progressive reveal sweeping from muted gray to neon cyan",
    accentColor: "#00FFA3",
    systemStyleId: "karaoke-fill",
  },
  {
    key: "editorial_ghost",
    title: "Editorial Ghost",
    creatorTag: "Executive Podcast",
    badgeText: "Thought Leadership",
    description: "Elegant minimalist typography with subtle pill contrast",
    accentColor: "#FFFFFF",
    systemStyleId: "editorial-ghost-type",
  },
  {
    key: "neon_pulse",
    title: "Neon Cyber Pulse",
    creatorTag: "Cyber Glow",
    badgeText: "Sci-Fi / Tech",
    description: "Glowing neon aura, futuristic display, high-contrast glow",
    accentColor: "#00F0FF",
    systemStyleId: "neon-glow",
  },
];

const DEFAULT_CANVAS: CanvasSize = { width: 1080, height: 1920 };

export function PresetCarousel({
  selectedStyleId,
  scope = { kind: "doc" },
  onOp,
  onSelectPreset,
  canvas = DEFAULT_CANVAS,
  className,
}: PresetCarouselProps): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = useState<ViralPresetKey | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const preview = fitPreview(canvas, 140, 180);

  const handleSelect = useCallback(
    (item: PresetMetadata) => {
      const startTime = performance.now();
      const presetData = BUILTIN_PRESETS[item.key];
      const compiledDoc = compilePresetToStyleDoc(item.key);

      // 1. Emit the editor op targeting the corresponding system style
      if (onOp) {
        onOp(setStyleRef(scope, item.systemStyleId));
      }

      // 2. Invoke client callback with full metadata
      if (onSelectPreset) {
        onSelectPreset(item.key, presetData, compiledDoc);
      }

      // Assert switch latency SLA
      const elapsedMs = performance.now() - startTime;
      if (elapsedMs > 50 && typeof console !== "undefined") {
        console.warn(`[PresetCarousel] Switch latency SLA exceeded: ${elapsedMs.toFixed(2)}ms`);
      }
    },
    [scope, onOp, onSelectPreset],
  );

  const scroll = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const offset = direction === "left" ? -240 : 240;
    scrollRef.current.scrollBy({ left: offset, behavior: "smooth" });
  };

  return (
    <div
      className={cn("flex flex-col gap-2.5", className)}
      data-testid="preset-carousel"
      role="region"
      aria-label="Popular viral caption style presets"
    >
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-4 text-accent" aria-hidden="true" />
          <h3 className="text-xs font-semibold tracking-wide uppercase text-fg-0">
            Popular Viral Styles
          </h3>
          <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            1-Click Viral
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => scroll("left")}
            aria-label="Scroll left"
            className="flex size-6 items-center justify-center rounded-sm border border-border bg-bg-1 text-fg-2 transition-colors hover:text-fg-0 hover:border-fg-2/60"
            data-testid="preset-carousel-scroll-left"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => scroll("right")}
            aria-label="Scroll right"
            className="flex size-6 items-center justify-center rounded-sm border border-border bg-bg-1 text-fg-2 transition-colors hover:text-fg-0 hover:border-fg-2/60"
            data-testid="preset-carousel-scroll-right"
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto pb-2 pt-0.5 scrollbar-none snap-x snap-mandatory"
        role="radiogroup"
        aria-label="Viral style presets options"
      >
        {VIRAL_PRESETS_METADATA.map((meta) => {
          const isSelected =
            selectedStyleId === meta.systemStyleId ||
            selectedStyleId === meta.key ||
            selectedStyleId === VIRAL_PRESET_TO_SYSTEM_STYLE[meta.key];

          const isHovered = hoveredKey === meta.key;
          const presetDoc =
            SYSTEM_STYLE_MAP.get(meta.systemStyleId) ?? compilePresetToStyleDoc(meta.key);

          return (
            <div
              key={meta.key}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSelect(meta);
                }
              }}
              onClick={() => handleSelect(meta)}
              onPointerEnter={() => setHoveredKey(meta.key)}
              onPointerLeave={() =>
                setHoveredKey((cur) => (cur === meta.key ? undefined : cur))
              }
              className={cn(
                "group relative flex w-[156px] shrink-0 snap-start flex-col overflow-hidden rounded-md border text-left transition-all duration-200 cursor-pointer select-none",
                isSelected
                  ? "border-accent bg-bg-1 ring-1 ring-accent shadow-sm shadow-accent/20"
                  : "border-border bg-bg-0 hover:border-fg-2/70 hover:bg-bg-1/60",
              )}
              data-testid={`preset-card-${meta.key}`}
              data-selected={isSelected ? "true" : "false"}
            >
              {/* Preview canvas with hover animation */}
              <div className="relative mx-auto flex items-center justify-center overflow-hidden bg-bg-2 p-1 pt-1.5 w-full">
                <StylePreviewCanvas
                  style={presetDoc}
                  width={preview.width}
                  height={preview.height}
                  playing={isHovered}
                  className="rounded-sm shadow-inner"
                />

                {/* Selection badge */}
                {isSelected && (
                  <div
                    className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-accent text-bg-0 shadow"
                    data-testid={`preset-selected-badge-${meta.key}`}
                  >
                    <Check className="size-3 stroke-[3]" aria-hidden="true" />
                  </div>
                )}

                {/* Aesthetic Tag pill */}
                <span
                  className="absolute bottom-2 left-2 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold text-white backdrop-blur-xs"
                  style={{ borderLeft: `2.5px solid ${meta.accentColor}` }}
                >
                  {meta.badgeText}
                </span>
              </div>

              {/* Information body */}
              <div className="flex flex-col gap-1 p-2">
                <div className="flex items-center justify-between gap-1">
                  <span
                    className={cn(
                      "text-xs font-semibold truncate",
                      isSelected ? "text-accent" : "text-fg-0 group-hover:text-fg-0",
                    )}
                  >
                    {meta.title}
                  </span>
                </div>

                <div className="flex items-center gap-1 text-[10px] text-fg-2">
                  <Zap className="size-2.5 text-accent/80 shrink-0" aria-hidden="true" />
                  <span className="truncate">{BUILTIN_PRESETS[meta.key].fontFamily}</span>
                  <span className="text-fg-disabled">•</span>
                  <span>{BUILTIN_PRESETS[meta.key].maxWordsPerScreen}w</span>
                </div>

                <p className="line-clamp-2 text-[10px] text-fg-2/80 leading-tight">
                  {meta.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

