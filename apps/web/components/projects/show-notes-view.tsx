"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileText,
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
  useProject,
  useProjectShowNotes,
  useGenerateProjectShowNotes,
  type ProjectShowNotes,
  type YouTubeChapter,
  type NotableQuote,
} from "@montaj/api-client";
import { Button, cn, PageHeader, Skeleton } from "@montaj/ui";

interface ShowNotesViewProps {
  projectId: string;
}

export function ShowNotesView({ projectId }: ShowNotesViewProps): React.JSX.Element {
  const project = useProject(projectId);
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
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const showNotes: ProjectShowNotes | null = showNotesQuery.data ?? null;
  const isGenerating = generateMutation.isPending;
  const isLoading = showNotesQuery.isPending;

  const handleGenerate = (force = false) => {
    generateMutation.mutate({ forceRegenerate: force });
  };

  // 1-Click "Copy YouTube Chapters" text formatter
  const formattedChaptersText = React.useMemo(() => {
    if (!showNotes?.youtubeChapters) return "";
    return showNotes.youtubeChapters
      .map((ch: YouTubeChapter) => `${ch.timestamp} - ${ch.title}`)
      .join("\n");
  }, [showNotes]);

  // 1-Click "Copy Full YouTube Description" text formatter
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
    <div className="flex flex-col gap-6 max-w-6xl mx-auto pb-16" data-testid="show-notes-view">
      {/* Navigation bar */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/p/${projectId}`} className="flex items-center gap-1.5 text-fg-2 hover:text-fg-0">
              <ArrowLeft className="h-4 w-4" />
              <span>Back to Editor</span>
            </Link>
          </Button>
          <span className="text-fg-3">/</span>
          <span className="text-sm font-medium text-fg-1 truncate max-w-md">
            {project.data?.title ?? "Project"}
          </span>
          <span className="text-fg-3">/</span>
          <span className="text-sm font-semibold text-accent">Show Notes & Timestamps</span>
        </div>

        <div className="flex items-center gap-2">
          {showNotes && (
            <Button
              variant="outline"
              size="sm"
              disabled={isGenerating}
              onClick={() => handleGenerate(true)}
              className="flex items-center gap-1.5"
              data-testid="regenerate-show-notes-btn"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isGenerating && "animate-spin")} />
              <span>{isGenerating ? "Regenerating..." : "Regenerate"}</span>
            </Button>
          )}
          <Button asChild variant="secondary" size="sm">
            <Link href={`/p/${projectId}`} className="flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              <span>Open in Editor</span>
            </Link>
          </Button>
        </div>
      </div>

      <PageHeader
        title="AI Show Notes, Chapters & Timestamps"
        description="Standard YouTube scrubber markers, executive episode summaries, and bulleted takeaways ready for YouTube Studio, Spotify & Apple Podcasts."
      />

      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-col gap-4 py-8">
          <Skeleton className="h-12 w-full rounded-md" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Skeleton className="h-64 col-span-2 rounded-md" />
            <Skeleton className="h-64 rounded-md" />
          </div>
        </div>
      )}

      {/* Empty state: No show notes generated yet */}
      {!isLoading && !showNotes && (
        <div
          className="flex flex-col items-center justify-center p-12 text-center rounded-xl border border-dashed border-border bg-bg-1/50 my-8 gap-4"
          data-testid="show-notes-empty-state"
        >
          <div className="h-14 w-14 rounded-full bg-accent/10 flex items-center justify-center text-accent">
            <Sparkles className="h-7 w-7" />
          </div>
          <div className="max-w-md">
            <h3 className="text-lg font-semibold text-fg-0 mb-1">
              No Show Notes Generated Yet
            </h3>
            <p className="text-sm text-fg-2">
              Transform this episode's transcript into interactive YouTube chapters, executive summaries, and publish-ready descriptions with one click.
            </p>
          </div>
          <Button
            size="lg"
            disabled={isGenerating}
            onClick={() => handleGenerate(false)}
            className="flex items-center gap-2 mt-2"
            data-testid="generate-show-notes-primary-btn"
          >
            <Sparkles className={cn("h-4 w-4", isGenerating && "animate-spin")} />
            <span>{isGenerating ? "Analyzing & Generating..." : "Generate Show Notes & Chapters"}</span>
          </Button>
          {generateMutation.isError && (
            <p className="text-xs text-destructive mt-2">
              Failed to generate: {(generateMutation.error as Error)?.message || "Ensure the project has a transcript."}
            </p>
          )}
        </div>
      )}

      {/* Main Content Area: Show Notes Ready */}
      {!isLoading && showNotes && (
        <div className="flex flex-col gap-8">
          {/* Top action banner: 1-Click Copy Full YouTube Description */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-xl border border-border bg-bg-1 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center shrink-0">
                <YoutubeIcon className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-fg-0">
                  Ready for YouTube Studio & Podcast RSS
                </h4>
                <p className="text-xs text-fg-2">
                  Complete episode description package adhering strictly to YouTube scrubber requirements (starts at 00:00, &Delta;t &ge; 10s).
                </p>
              </div>
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() => copyToClipboard(formattedFullDescriptionText, "full-description")}
              className="w-full sm:w-auto shrink-0 flex items-center gap-2"
              data-testid="copy-full-description-btn"
            >
              {copiedKey === "full-description" ? (
                <>
                  <Check className="h-4 w-4 text-green-400" />
                  <span>Copied Full Description!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span>Copy Full YouTube Description</span>
                </>
              )}
            </Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Chapters & Timestamps (5 cols) */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              <div className="rounded-xl border border-border bg-bg-1 p-6 flex flex-col gap-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold text-fg-0">Interactive YouTube Chapters</h3>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(formattedChaptersText, "chapters")}
                    className="h-8 text-xs flex items-center gap-1.5"
                    data-testid="copy-youtube-chapters-btn"
                  >
                    {copiedKey === "chapters" ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-green-400" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>Copy Chapters</span>
                      </>
                    )}
                  </Button>
                </div>

                <div className="flex items-center gap-2 text-xs text-fg-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 font-medium">
                    &bull; YouTube Compliant
                  </span>
                  <span>{showNotes.youtubeChapters.length} Chapters detected</span>
                </div>

                <div className="flex flex-col divide-y divide-border/60 max-h-[500px] overflow-y-auto pr-1">
                  {showNotes.youtubeChapters.map((chapter: YouTubeChapter, idx: number) => (
                    <div
                      key={idx}
                      className="py-2.5 flex items-start justify-between gap-3 group hover:bg-bg-2/50 px-2 rounded-md transition-colors"
                      data-testid={`chapter-item-${idx}`}
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <span className="font-mono text-xs font-semibold px-2 py-1 rounded bg-bg-2 text-accent shrink-0 select-all">
                          {chapter.timestamp}
                        </span>
                        <span className="text-sm text-fg-1 font-medium leading-snug">
                          {chapter.title}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(`${chapter.timestamp} - ${chapter.title}`, `ch-${idx}`)}
                        className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-fg-0 p-1 transition-opacity shrink-0"
                        title="Copy chapter line"
                      >
                        {copiedKey === `ch-${idx}` ? (
                          <Check className="h-3.5 w-3.5 text-green-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Notable Quotes Card */}
              {showNotes.notableQuotes && showNotes.notableQuotes.length > 0 && (
                <div className="rounded-xl border border-border bg-bg-1 p-6 flex flex-col gap-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center gap-2">
                      <Quote className="h-4 w-4 text-accent" />
                      <h3 className="text-sm font-semibold text-fg-0">Notable Direct Quotes</h3>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        copyToClipboard(
                          showNotes.notableQuotes
                            .map((q: NotableQuote) => `"${q.quote}" — ${q.speaker}`)
                            .join("\n\n"),
                          "quotes"
                        )
                      }
                      className="h-8 text-xs flex items-center gap-1.5 text-fg-2 hover:text-fg-0"
                      data-testid="copy-quotes-btn"
                    >
                      {copiedKey === "quotes" ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-green-400" />
                          <span>Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span>Copy Quotes</span>
                        </>
                      )}
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3">
                    {showNotes.notableQuotes.map((q: NotableQuote, idx: number) => (
                      <div
                        key={idx}
                        className="p-3.5 rounded-lg border border-border/80 bg-bg-2/30 flex flex-col gap-2 text-sm"
                        data-testid={`quote-item-${idx}`}
                      >
                        <p className="italic text-fg-1 leading-relaxed">
                          &ldquo;{q.quote}&rdquo;
                        </p>
                        <div className="flex items-center justify-between text-xs text-fg-2 pt-1 border-t border-border/40">
                          <span className="font-semibold text-fg-0">{q.speaker}</span>
                          <span className="font-mono text-accent">
                            {Math.floor(q.timestampSec / 60)}:{String(q.timestampSec % 60).padStart(2, "0")}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right Column: Executive Summary & Key Takeaways (7 cols) */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              {/* Executive Summary Card */}
              <div className="rounded-xl border border-border bg-bg-1 p-6 flex flex-col gap-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold text-fg-0">Executive Episode Summary</h3>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(showNotes.summary, "summary")}
                    className="h-8 text-xs flex items-center gap-1.5"
                    data-testid="copy-summary-btn"
                  >
                    {copiedKey === "summary" ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-green-400" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>Copy Summary</span>
                      </>
                    )}
                  </Button>
                </div>

                <div className="flex flex-col gap-3 text-sm text-fg-1 leading-relaxed">
                  {(showNotes.summary || "").split("\n\n").map((para: string, idx: number) => (
                    <p key={idx} className="text-fg-1">
                      {para}
                    </p>
                  ))}
                </div>
              </div>

              {/* Key Takeaways Card */}
              <div className="rounded-xl border border-border bg-bg-1 p-6 flex flex-col gap-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <ListChecks className="h-4 w-4 text-accent" />
                    <h3 className="text-sm font-semibold text-fg-0">Key Bulleted Takeaways</h3>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      copyToClipboard(
                        showNotes.keyTakeaways.map((point: string) => `• ${point}`).join("\n"),
                        "takeaways"
                      )
                    }
                    className="h-8 text-xs flex items-center gap-1.5"
                    data-testid="copy-takeaways-btn"
                  >
                    {copiedKey === "takeaways" ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-green-400" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>Copy Takeaways</span>
                      </>
                    )}
                  </Button>
                </div>

                <ul className="flex flex-col gap-2.5">
                  {showNotes.keyTakeaways.map((point: string, idx: number) => (
                    <li
                      key={idx}
                      className="flex items-start gap-3 p-2.5 rounded-lg bg-bg-2/40 text-sm text-fg-1"
                      data-testid={`takeaway-item-${idx}`}
                    >
                      <span className="h-5 w-5 rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold">
                        {idx + 1}
                      </span>
                      <span className="leading-relaxed">{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
