"use client";

import * as React from "react";
import { cn } from "@montaj/ui";
import type { YouTubeProbeResponse } from "@montaj/repurpose-contracts";
import { formatClock } from "@/components/repurpose/moment-time";
import { Play, Sparkles, Subtitles, ListStart } from "lucide-react";

export interface YouTubePreviewCardProps {
  readonly probe?: YouTubeProbeResponse | null;
  readonly isLoading?: boolean;
  readonly error?: string | null;
  readonly onSelectChapter?: (startSec: number) => void;
  readonly className?: string;
}

export function YouTubePreviewCard({
  probe,
  isLoading = false,
  error = null,
  onSelectChapter,
  className,
}: YouTubePreviewCardProps) {
  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "rounded-lg border border-border/70 bg-sunken/40 p-3 animate-pulse",
          className,
        )}
        data-testid="youtube-preview-skeleton"
      >
        <div className="flex gap-3">
          <div className="w-28 sm:w-36 aspect-video bg-border/40 rounded flex-shrink-0" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-4 bg-border/40 rounded w-4/5" />
            <div className="h-3 bg-border/30 rounded w-1/3" />
            <div className="h-3 bg-border/20 rounded w-1/4" />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-fg-3 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-accent animate-ping" />
          Probing video details and native chapters...
        </p>
      </div>
    );
  }

  if (error && !probe) {
    return (
      <div
        className={cn(
          "rounded-lg border border-border/40 bg-sunken/20 px-3 py-2 text-xs text-fg-3",
          className,
        )}
        data-testid="youtube-preview-error"
      >
        <span>Preview unavailable for this link; you can still start processing.</span>
      </div>
    );
  }

  if (!probe) {
    return null;
  }

  const chapters = probe.nativeChapters ?? [];
  const durationText = probe.isLiveStream
    ? "LIVE"
    : formatClock(probe.durationSec * 1000);

  return (
    <section
      aria-label="YouTube video preview"
      className={cn(
        "rounded-lg border border-border/80 bg-sunken/50 p-3 space-y-2.5 transition-all",
        className,
      )}
      data-testid="youtube-preview-card"
    >
      <div className="flex flex-col sm:flex-row gap-3 items-start">
        {/* Thumbnail with duration badge */}
        <div className="relative w-full sm:w-36 aspect-video rounded overflow-hidden bg-black/20 flex-shrink-0 border border-border/40">
          {probe.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={probe.thumbnailUrl}
              alt={probe.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-sunken text-fg-3">
              <Play className="w-6 h-6 opacity-40" />
            </div>
          )}
          <span
            className={cn(
              "absolute bottom-1 right-1 rounded px-1 py-0.5 text-[10px] font-mono font-medium tracking-tight shadow-sm",
              probe.isLiveStream
                ? "bg-red-600 text-white font-bold"
                : "bg-black/85 text-white",
            )}
          >
            {durationText}
          </span>
        </div>

        {/* Video metadata */}
        <div className="flex-1 min-w-0 space-y-1">
          <h3
            className="text-xs sm:text-sm font-semibold text-fg-0 line-clamp-2 leading-snug"
            title={probe.title}
          >
            {probe.title}
          </h3>
          <p className="text-xs text-fg-2 truncate font-medium">
            {probe.channelName || "YouTube Channel"}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-fg-3">
            {probe.hasCaptions ? (
              <span className="inline-flex items-center gap-1 text-emerald-500 font-medium">
                <Subtitles className="w-3.5 h-3.5" />
                Captions available
              </span>
            ) : null}
            {chapters.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-accent font-medium">
                <Sparkles className="w-3 h-3" />
                {chapters.length} creator {chapters.length === 1 ? "chapter" : "chapters"}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Interactive native chapter chips */}
      {chapters.length > 0 ? (
        <div className="pt-1.5 border-t border-border/50 space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-fg-2 flex items-center gap-1">
              <ListStart className="w-3.5 h-3.5 text-accent" />
              Creator Chapters:
            </span>
            <span className="text-fg-3 text-[10px]">
              Click a chapter to set Start at
            </span>
          </div>

          <div
            className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pr-1"
            role="group"
            aria-label="Chapter boundaries"
          >
            {chapters.map((chapter, index) => {
              const clockText = formatClock(chapter.startSec * 1000);
              return (
                <button
                  key={`${chapter.startSec}-${index}`}
                  type="button"
                  onClick={() => onSelectChapter?.(chapter.startSec)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-border/80 bg-subtle/80 hover:bg-hover hover:border-accent text-fg-1 hover:text-fg-0 transition-all cursor-pointer group active:scale-[0.98]"
                  title={`Start repurposing at ${chapter.title} (${clockText})`}
                  data-testid={`chapter-chip-${index}`}
                >
                  <span className="font-mono text-[10px] text-accent font-semibold group-hover:underline">
                    {clockText}
                  </span>
                  <span className="truncate max-w-[160px] text-fg-1 group-hover:text-fg-0">
                    {chapter.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

