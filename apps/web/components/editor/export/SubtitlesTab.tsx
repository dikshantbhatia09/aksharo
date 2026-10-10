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
  { value: "srt", label: "SRT (SubRip for NLE Timelines & YouTube CC)" },
  { value: "vtt", label: "VTT (WebVTT for HTML5 Web Players)" },
  { value: "ass", label: "ASS (Advanced SubStation Alpha with Karaoke Tags)" },
  { value: "txt", label: "Plain text (Raw Transcript)" },
  { value: "md", label: "Markdown (cloud)", disabled: true },
];

export function SubtitlesTab({
  value,
  onChange,
  disabled,
  assExportable = true,
}: {
  readonly value: SubtitlesTabValue;
  readonly onChange: (value: SubtitlesTabValue) => void;
  readonly disabled: boolean;
  readonly assExportable?: boolean;
}): React.JSX.Element {
  const toggle = (format: SubtitleFormat): void => {
    const has = value.formats.includes(format);
    onChange({
      ...value,
      formats: has ? value.formats.filter((f) => f !== format) : [...value.formats, format],
    });
  };

  const formats = React.useMemo(() => {
    const list: {
      readonly value: SubtitleFormat;
      readonly label: string;
      readonly disabled?: boolean;
    }[] = [
      { value: "srt", label: "SRT (SubRip for NLE Timelines & YouTube CC)" },
      { value: "vtt", label: "VTT (WebVTT for HTML5 Web Players)" },
      { value: "txt", label: "Plain text (Raw Transcript)" },
    ];
    if (assExportable) {
      list.push({ value: "ass", label: "ASS (Advanced SubStation Alpha with Karaoke Tags)" });
    }
    list.push({ value: "md", label: "Markdown (cloud)", disabled: true });
    return list;
  }, [assExportable]);

  return (
    <div className="space-y-2 py-2" data-testid="export-subtitles-tab">
      {formats.map((format) => (
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
      {!assExportable ? (
        <p
          className="text-fg-2 text-[11px] opacity-70"
          data-testid="ass-export-unsupported-note"
          title={assExportUnavailableReason()}
        >
          ASS export is not available for this style.
        </p>
      ) : null}
    </div>
  );
}
