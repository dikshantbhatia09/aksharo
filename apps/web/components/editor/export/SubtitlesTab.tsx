"use client";

import * as React from "react";

import type { SubtitleFormat, SubtitleScript } from "@montaj/render-manifest";

import { assExportUnavailableReason } from "@/lib/export/subtitles";

export interface SubtitlesTabValue {
  readonly formats: readonly SubtitleFormat[];
  readonly scripts: readonly SubtitleScript[];
}

const CLIENT_FORMATS: {
  readonly value: SubtitleFormat;
  readonly label: string;
  readonly disabled?: boolean;
}[] = [
  { value: "srt", label: "SRT" },
  { value: "vtt", label: "VTT" },
  { value: "txt", label: "Plain text" },
  { value: "ass", label: "ASS (not available yet)", disabled: true },
  { value: "md", label: "Markdown (cloud)", disabled: true },
];

export function SubtitlesTab({
  value,
  onChange,
  disabled,
}: {
  readonly value: SubtitlesTabValue;
  readonly onChange: (value: SubtitlesTabValue) => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  const toggle = (format: SubtitleFormat): void => {
    const has = value.formats.includes(format);
    onChange({
      ...value,
      formats: has ? value.formats.filter((f) => f !== format) : [...value.formats, format],
    });
  };

  return (
    <div className="space-y-2 py-2" data-testid="export-subtitles-tab">
      {CLIENT_FORMATS.map((format) => (
        <label key={format.value} className="text-fg-2 flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={value.formats.includes(format.value)}
            disabled={disabled || format.disabled === true}
            onChange={() => toggle(format.value)}
            data-testid={`export-subtitle-format-${format.value}`}
          />
          {format.label}
        </label>
      ))}
      <p className="text-fg-2 text-[11px] opacity-70" title={assExportUnavailableReason()}>
        ASS export ships once @montaj/ass-exporter lands.
      </p>
    </div>
  );
}
