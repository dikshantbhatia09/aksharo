"use client";

import * as React from "react";

import type { RenderPreset, SubtitleScript } from "@montaj/render-manifest";

export interface VideoTabValue {
  readonly preset: RenderPreset;
  readonly script: SubtitleScript;
  readonly dropFillers: boolean;
}

const PRESETS: { readonly value: RenderPreset; readonly label: string }[] = [
  { value: "reels", label: "Reels / TikTok (1080×1920)" },
  { value: "shorts", label: "YouTube Shorts (1080×1920)" },
  { value: "youtube-4k", label: "YouTube 4K (3840×2160)" },
  { value: "square", label: "Square (1080×1080)" },
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
  return (
    <div className="space-y-3 py-2" data-testid="export-video-tab">
      <div>
        <label className="text-fg-2 mb-1 block text-xs font-medium" htmlFor="export-preset">
          Preset
        </label>
        <select
          id="export-preset"
          data-testid="export-preset-select"
          className="bg-bg-2 w-full rounded-md border border-white/10 px-2 py-1.5 text-sm"
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
