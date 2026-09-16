"use client";

/**
 * K07: extends the existing preset system with two Instagram-platform
 * entries and adds the caption-opacity slider — both scoped from
 * `ADDENDUM-full-frame-audit.md`'s "New gap 6" (Kalakar frame 0305 shows an
 * export-time picker: Instagram Reels/Story/Feed, TikTok For You, YouTube
 * Shorts, plus a 100%-default opacity slider for the caption overlay).
 *
 * **Preset decisions** (`PRESET_DIMENSIONS`/`RENDER_PRESETS` in
 * `@montaj/render-manifest` carry the reasoning too):
 * - `instagram-story` is a new, distinct `RenderPreset` value even though its
 *   canvas (1080×1920, 9:16) is byte-for-byte identical to `reels`'s. Two
 *   reasons: (1) precedent — `reels` and `shorts` are already separate
 *   values despite being pixel-identical, so "separate platform, separate
 *   value" is this codebase's existing convention, not a new one; (2)
 *   mechanics — a native `<select>` cannot correctly host two *different*
 *   labelled `<option>`s that share one `value` (selecting either one still
 *   reads back whichever option the DOM resolves first for that value, so a
 *   click on "Instagram Story" could silently fail to change anything
 *   visible), so offering it as its own selectable option needs its own
 *   value regardless of whether the investigation found a technical
 *   difference.
 * - `instagram-feed` is a new distinct value with a genuinely different
 *   aspect (4:5, 1080×1350) — the existing `square` preset only covers
 *   Instagram's 1:1 feed variant, not 4:5.
 * - **TikTok stays folded into "Reels / TikTok"** (no split). Investigated
 *   whether `RenderPreset` drives anything beyond aspect+label+dimensions
 *   (platform-specific safe margins, bitrate/crf tiers): it does not —
 *   `apps/api/src/exports/decision.ts`'s `requestedWidth` buckets every
 *   preset except `youtube-4k`/`custom` to the same 1080px width, and
 *   safe-area percentages come from `LayoutSchema.safeAreaPct` (aspect/style
 *   driven), never from `RenderPreset`. With no technical difference and no
 *   acceptance criterion naming TikTok as a required distinct option (unlike
 *   Instagram Story/Feed), splitting it would only grow the enum with no
 *   functional payoff — kept as the shipped combined label.
 */

import * as React from "react";

import type { RenderPreset, SubtitleScript } from "@montaj/render-manifest";

export interface VideoTabValue {
  readonly preset: RenderPreset;
  readonly script: SubtitleScript;
  readonly dropFillers: boolean;
  /**
   * K07: overall opacity of the rendered caption/subtitle overlay, `0`-`1`.
   * `1` (100%, the reference product's default) reproduces every export from
   * before this field existed byte-for-byte — see
   * `packages/render-core/src/animate/animate.ts`'s `AnimateOptions.captionOpacity`.
   */
  readonly captionOpacity: number;
}

const PRESETS: { readonly value: RenderPreset; readonly label: string }[] = [
  { value: "reels", label: "Reels / TikTok (1080×1920)" },
  { value: "shorts", label: "YouTube Shorts (1080×1920)" },
  { value: "youtube-4k", label: "YouTube 4K (3840×2160)" },
  { value: "square", label: "Square (1080×1080)" },
  { value: "instagram-story", label: "Instagram Story (1080×1920)" },
  { value: "instagram-feed", label: "Instagram Feed (1080×1350)" },
];

export function VideoTab({
  value,
  onChange,
  disabled,
}: {
  readonly value: VideoTabValue;
  readonly onChange: (value: VideoTabValue) => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  const opacityPct = Math.round(value.captionOpacity * 100);
  return (
    <div className="space-y-3 py-2" data-testid="export-video-tab">
      <div>
        <label className="text-fg-2 mb-1 block text-xs font-medium" htmlFor="export-preset">
          Preset
        </label>
        <select
          id="export-preset"
          data-testid="export-preset-select"
          className="bg-bg-2 border-border w-full rounded-md border px-2 py-1.5 text-sm"
          value={value.preset}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, preset: event.target.value as RenderPreset })}
        >
          {PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label
          className="text-fg-2 mb-1 flex items-center justify-between text-xs font-medium"
          htmlFor="export-caption-opacity"
        >
          <span>Caption opacity</span>
          <span
            className="text-fg-3 tabular-nums font-normal"
            data-testid="export-caption-opacity-value"
          >
            {opacityPct}%
          </span>
        </label>
        <input
          id="export-caption-opacity"
          data-testid="export-caption-opacity-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={opacityPct}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, captionOpacity: Number(event.target.value) / 100 })
          }
          className="w-full"
        />
      </div>
      <label className="text-fg-3 flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={value.dropFillers}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, dropFillers: event.target.checked })}
        />
        Drop filler words
      </label>
    </div>
  );
}
