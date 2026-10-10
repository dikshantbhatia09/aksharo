"use client";

import * as React from "react";
import Link from "next/link";
import {
  BookOpen,
  Check,
  Clock,
  Copy,
  ExternalLink,
  ListChecks,
  Quote,
  RefreshCw,
  Sparkles,
} from "lucide-react";

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

import {
  useProjectShowNotes,
  useGenerateProjectShowNotes,
  type ProjectShowNotes,
  type YouTubeChapter,
  type NotableQuote,
} from "@montaj/api-client";
import { Button, cn } from "@montaj/ui";

interface ShowNotesDrawerProps {
  projectId: string;
  onSeek?: (ms: number) => void;
}

export function ShowNotesDrawer({ projectId, onSeek }: ShowNotesDrawerProps): React.JSX.Element {
  const showNotesQuery = useProjectShowNotes(projectId);
  const generateMutation = useGenerateProjectShowNotes(projectId);

  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey(null);
      }, 2500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const showNotes: ProjectShowNotes | null = showNotesQuery.data ?? null;
  const isGenerating = generateMutation.isPending;
  const isLoading = showNotesQuery.isPending;

  const formattedChaptersText = React.useMemo(() => {
    if (!showNotes?.youtubeChapters) return "";
    return showNotes.youtubeChapters
      .map((ch: YouTubeChapter) => `${ch.timestamp} - ${ch.title}`)
      .join("\n");
  }, [showNotes]);

  const formattedFullDescriptionText = React.useMemo(() => {
    if (!showNotes) return "";
    const sections: string[] = [];

    if (showNotes.summary) {
      sections.push(`ABOUT THIS EPISODE\n${showNotes.summary}`);
    }

    if (showNotes.youtubeChapters && showNotes.youtubeChapters.length > 0) {
      const chaptersList = showNotes.youtubeChapters
        .map((ch: YouTubeChapter) => `${ch.timestamp} - ${ch.title}`)
        .join("\n");
      sections.push(`TIMESTAMPS & CHAPTERS\n${chaptersList}`);
    }

    if (showNotes.keyTakeaways && showNotes.keyTakeaways.length > 0) {
      const bullets = showNotes.keyTakeaways.map((point: string) => `• ${point}`).join("\n");
      sections.push(`KEY TAKEAWAYS\n${bullets}`);
    }

    if (showNotes.notableQuotes && showNotes.notableQuotes.length > 0) {
      const quotes = showNotes.notableQuotes
        .map((q: NotableQuote) => `"${q.quote}" — ${q.speaker} (${Math.floor(q.timestampSec / 60)}:${String(q.timestampSec % 60).padStart(2, "0")})`)
        .join("\n");
      sections.push(`MEMORABLE QUOTES\n${quotes}`);
    }

    return sections.join("\n\n---\n\n");
  }, [showNotes]);

  return (
    <div
      className="flex h-full flex-col overflow-y-auto bg-bg-0 p-4 border-r border-border text-fg-0 gap-4"
      data-testid="show-notes-drawer"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold text-fg-0">Show Notes & Chapters</h3>
        </div>
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs px-2 gap-1 text-fg-2 hover:text-fg-0">
          <Link href={`/projects/${projectId}/show-notes`}>
            <span>Full Page</span>
            <ExternalLink className="h-3 w-3" />
          </Link>
        </Button>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-col gap-3 py-6">
          <div className="h-8 w-full rounded bg-bg-2 animate-pulse" />
          <div className="h-32 w-full rounded bg-bg-2 animate-pulse" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !showNotes && (
        <div className="flex flex-col items-center justify-center p-6 text-center rounded-lg border border-dashed border-border bg-bg-1/40 my-4 gap-3">
          <div className="h-10 w-10 rounded-full bg-accent/10 flex items-center justify-center text-accent">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h4 className="text-sm font-medium text-fg-0">No Show Notes Yet</h4>
            <p className="text-xs text-fg-2 mt-1">
              Generate interactive YouTube chapters and show notes from your transcript.
            </p>
          </div>
          <Button
            size="sm"
            disabled={isGenerating}
            onClick={() => generateMutation.mutate({ forceRegenerate: false })}
            className="flex items-center gap-1.5 mt-1"
            data-testid="drawer-generate-btn"
          >
            <Sparkles className={cn("h-3.5 w-3.5", isGenerating && "animate-spin")} />
            <span>{isGenerating ? "Generating..." : "Generate Show Notes"}</span>
          </Button>
        </div>
      )}

      {/* Show Notes Content */}
      {!isLoading && showNotes && (
        <div className="flex flex-col gap-4">
          {/* Quick Copy Action Bar */}
          <div className="flex flex-col gap-2 p-3 rounded-lg bg-bg-1 border border-border">
            <Button
              variant="primary"
              size="sm"
              onClick={() => copyToClipboard(formattedFullDescriptionText, "drawer-full")}
              className="w-full flex items-center justify-center gap-1.5 text-xs h-8"
              data-testid="drawer-copy-full-btn"
            >
              {copiedKey === "drawer-full" ? (
                <>
                  <Check className="h-3.5 w-3.5 text-green-400" />
                  <span>Copied Full Description!</span>
                </>
              ) : (
                <>
                  <YoutubeIcon className="h-3.5 w-3.5 text-red-400" />
                  <span>Copy Full YouTube Description</span>
                </>
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => copyToClipboard(formattedChaptersText, "drawer-chapters")}
              className="w-full flex items-center justify-center gap-1.5 text-xs h-8"
              data-testid="drawer-copy-chapters-btn"
            >
              {copiedKey === "drawer-chapters" ? (
                <>
                  <Check className="h-3.5 w-3.5 text-green-400" />
                  <span>Copied Chapters!</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy Chapters Only</span>
                </>
              )}
            </Button>
          </div>

          {/* Chapters Section */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-semibold text-fg-1">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-accent" />
                <span>YouTube Chapters ({showNotes.youtubeChapters.length})</span>
              </span>
            </div>

            <div className="flex flex-col divide-y divide-border/50 rounded-lg border border-border bg-bg-1 overflow-hidden">
              {showNotes.youtubeChapters.map((ch: YouTubeChapter, idx: number) => (
                <button
                  type="button"
                  key={idx}
                  onClick={() => onSeek?.(ch.startSec * 1000)}
                  className={cn(
                    "flex items-center justify-between p-2 text-xs text-left w-full transition-colors",
                    onSeek ? "hover:bg-bg-2 cursor-pointer" : "hover:bg-bg-2/40"
                  )}
                  title={onSeek ? `Seek to ${ch.timestamp}` : undefined}
                >
                  <span className="font-mono font-medium text-accent px-1.5 py-0.5 rounded bg-bg-2 shrink-0">
                    {ch.timestamp}
                  </span>
                  <span className="text-fg-1 font-medium truncate ml-2 flex-1">
                    {ch.title}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Key Takeaways Preview */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-fg-1">
              <ListChecks className="h-3.5 w-3.5 text-accent" />
              <span>Key Takeaways</span>
            </div>
            <ul className="flex flex-col gap-1.5 text-xs text-fg-2">
              {showNotes.keyTakeaways.slice(0, 4).map((point: string, idx: number) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <span className="text-accent font-bold">&bull;</span>
                  <span className="leading-tight">{point}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Footer Regenerate */}
          <div className="pt-2 border-t border-border flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={isGenerating}
              onClick={() => generateMutation.mutate({ forceRegenerate: true })}
              className="text-2xs text-fg-2 hover:text-fg-0 gap-1 h-7"
            >
              <RefreshCw className={cn("h-3 w-3", isGenerating && "animate-spin")} />
              <span>Regenerate</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
