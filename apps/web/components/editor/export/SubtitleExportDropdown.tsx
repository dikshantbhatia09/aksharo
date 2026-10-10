"use client";

import { ChevronDown, Download, FileCode, FileSpreadsheet, FileText } from "lucide-react";
import * as React from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import type { DisplayScript, EdgProjection } from "@montaj/render-core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@montaj/ui";

import {
  buildSubtitleCues,
  downloadFile,
  renderSubtitleFile,
  type SubtitleClientFormat,
} from "@/lib/export/subtitles";

export interface SubtitleExportDropdownProps {
  readonly projectId: string;
  readonly projection: EdgProjection;
  readonly catalogue?: ReadonlyMap<string, StyleDoc>;
  readonly script?: DisplayScript;
  readonly variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  readonly size?: "sm" | "md" | "lg" | "icon";
  readonly className?: string;
}

const MIME_MAP: Record<SubtitleClientFormat, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ass: "text/x-ssa",
  json: "application/json",
  txt: "text/plain",
};

export function SubtitleExportDropdown({
  projectId,
  projection,
  catalogue,
  script = "roman",
  variant = "secondary",
  size = "sm",
  className,
}: SubtitleExportDropdownProps): React.JSX.Element {
  const [downloading, setDownloading] = React.useState(false);

  const currentStyleId = projection?.styles?.defaultStyleId;
  const currentStyle =
    currentStyleId && catalogue ? catalogue.get(currentStyleId) : undefined;

  const handleDownload = React.useCallback(
    (format: SubtitleClientFormat) => {
      try {
        setDownloading(true);
        const cues = buildSubtitleCues({
          projection,
          timemap: null,
          script,
          includeWords: true,
        });

        if (cues.length === 0) {
          toast.error("No subtitle cues available to export.");
          return;
        }

        const content = renderSubtitleFile(cues, format, currentStyle);
        const filename = `subtitles-${projectId || "export"}.${format}`;
        downloadFile(content, filename, MIME_MAP[format] || "text/plain");

        toast.success(`Downloaded ${format.toUpperCase()} subtitles.`);
      } catch (err) {
        toast.error("Failed to generate subtitle export.");
      } finally {
        setDownloading(false);
      }
    },
    [projection, script, currentStyle, projectId],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          disabled={downloading}
          data-testid="subtitle-export-dropdown-trigger"
        >
          <Download className="size-3.5 mr-1" aria-hidden="true" />
          <span>Subtitles</span>
          <ChevronDown className="size-3.5 ml-1 opacity-70" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" data-testid="subtitle-export-dropdown-menu">
        <DropdownMenuLabel className="text-xs font-semibold">Download Subtitles</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleDownload("srt")}
          data-testid="subtitle-export-srt"
          className="cursor-pointer"
        >
          <FileText className="size-4 mr-2 text-primary" />
          <div>
            <div className="font-medium text-xs">SubRip (*.srt)</div>
            <div className="text-[10px] text-fg-2">Premiere, DaVinci & YouTube CC</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleDownload("vtt")}
          data-testid="subtitle-export-vtt"
          className="cursor-pointer"
        >
          <FileCode className="size-4 mr-2 text-info" />
          <div>
            <div className="font-medium text-xs">WebVTT (*.vtt)</div>
            <div className="text-[10px] text-fg-2">HTML5 video & web players</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleDownload("ass")}
          data-testid="subtitle-export-ass"
          className="cursor-pointer"
        >
          <FileSpreadsheet className="size-4 mr-2 text-success" />
          <div>
            <div className="font-medium text-xs">Advanced SubStation (*.ass)</div>
            <div className="text-[10px] text-fg-2">Rich typography & karaoke sync</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleDownload("json")}
          data-testid="subtitle-export-json"
          className="cursor-pointer"
        >
          <FileCode className="size-4 mr-2 text-warning" />
          <div>
            <div className="font-medium text-xs">Remotion Timeline (*.json)</div>
            <div className="text-[10px] text-fg-2">Structured timing & words</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleDownload("txt")}
          data-testid="subtitle-export-txt"
          className="cursor-pointer"
        >
          <FileText className="size-4 mr-2 text-fg-2" />
          <div>
            <div className="font-medium text-xs">Plain Text (*.txt)</div>
            <div className="text-[10px] text-fg-2">Raw transcript without timing</div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
