"use client";

import * as React from "react";

import type { InsightRow } from "@montaj/api-client";

import { CopyButton } from "./CopyButton";
import { chaptersAsYouTubeDescription, formatChapterTimestamp } from "./formatChapters";

export interface ChaptersPanelProps {
  readonly row: InsightRow;
  /** Seek the preview player to `ms` (source time). */
  readonly onSeek?: (ms: number) => void;
}

interface Chapter {
  readonly startMs: number;
  readonly title: string;
}

/**
 * Chapters list (brief §5): "copy as YouTube description format and
 * 'jump to'". The whole block copies as one YouTube-ready description; each
 * row also jumps the preview to that chapter's start.
 */
export function ChaptersPanel({ row, onSeek }: ChaptersPanelProps): React.JSX.Element {
  const chapters = (row.output["chapters"] as Chapter[] | undefined) ?? [];
  const description = React.useMemo(() => chaptersAsYouTubeDescription(chapters), [chapters]);

  if (chapters.length === 0) {
    return (
      <p className="text-fg-3 text-sm" data-testid="chapters-empty">
        No chapters yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="chapters-panel">
      <div className="flex items-center justify-between">
        <span className="text-fg-3 text-xs">{chapters.length} chapters</span>
        <CopyButton value={description} label="Chapters (YouTube description)" />
      </div>
      <ul className="flex flex-col gap-1">
        {chapters.map((chapter) => (
          <li key={`${String(chapter.startMs)}-${chapter.title}`}>
            <button
              type="button"
              data-testid={`chapter-jump-${String(chapter.startMs)}`}
              className="hover:bg-bg-2 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
              onClick={() => onSeek?.(chapter.startMs)}
            >
              <span className="text-fg-3 shrink-0 font-mono text-xs">
                {formatChapterTimestamp(chapter.startMs)}
              </span>
              <span className="truncate">{chapter.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
