"use client";

/**
 * One clip in the run page's grid (2026-10-01, OpusClip's clip library): its
 * picture, its score, its length, its title and two or three tags - and a
 * click opens everything else (`ClipDetailDialog`).
 *
 * The picture is the clip's own still (the 9:16 "vertical image" Autopilot
 * takes with the captions on it) when it has one, else a frame of its
 * captioned video, else what the clip is waiting for. Hovering a tile with a
 * video plays it silently, as a preview.
 *
 * While clips are being picked (`selection`, 2026-10-01: "Download selected")
 * a click ticks the tile instead of opening it; a clip not made yet cannot be
 * ticked.
 */
import { AlertTriangle, Check, Clock, Loader2, Play } from "lucide-react";
import * as React from "react";

import {
  clipCopyOf,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
} from "@montaj/api-client";
import { cn } from "@montaj/ui";

import { hookCategoryOf, tagsOf } from "./clip-analysis";

import { clipStateOf } from "@/components/repurpose/CandidateCard";
import { formatClock } from "@/components/repurpose/moment-time";

export interface ClipTileProps {
  readonly candidate: RepurposeCandidateItem;
  readonly clip: RepurposeClipItem | undefined;
  /** Its place by score, 1 for the best. */
  readonly rank: number;
  readonly onOpen: () => void;
  /** Present while clips are being picked. */
  readonly selection?: {
    readonly selected: boolean;
    /** The clip is made, so it can be picked. */
    readonly selectable: boolean;
    readonly onToggle: () => void;
  };
}

function posterOf(clip: RepurposeClipItem | undefined): string | undefined {
  const files = clip?.images?.files ?? [];
  const vertical =
    files.find((file) => file.id === "vertical-image") ??
    files.find((file) => file.height > file.width);
  return vertical?.items[0]?.url;
}

/** A score's colour band, as OpusClip colours its numbers: strong, good, fair. */
function scoreTone(score: number): string {
  if (score >= 80) return "text-accepted";
  if (score >= 65) return "text-warning";
  return "text-fg-1";
}

export function ClipTile({
  candidate,
  clip,
  rank,
  onOpen,
  selection,
}: ClipTileProps): React.JSX.Element {
  const [hovered, setHovered] = React.useState(false);
  const state = clip === undefined ? undefined : clipStateOf(clip);
  const copy = clipCopyOf(clip?.copy) ?? clipCopyOf(candidate.copy);
  const title = copy?.title ?? candidate.title ?? candidate.headline ?? "Suggested moment";
  const score = candidate.potentialScore ?? candidate.score;
  const durationS = Math.round((candidate.endMs - candidate.startMs) / 1000);
  const poster = posterOf(clip);
  const playUrl = clip?.captioned?.playUrl ?? clip?.mezzanineUrl ?? undefined;
  const tags = tagsOf(candidate);
  const hookCat = hookCategoryOf(candidate);
  const selected = selection?.selected === true;
  const named = `#${String(rank)} ${title}${score === undefined || score === null ? "" : `, score ${String(score)}`}`;

  return (
    <li className="min-w-0" data-testid={`clip-tile-${candidate.id}`}>
      <button
        type="button"
        onClick={selection === undefined ? onOpen : selection.onToggle}
        disabled={selection !== undefined && !selection.selectable}
        aria-pressed={selection === undefined ? undefined : selected}
        onMouseEnter={() => {
          setHovered(true);
        }}
        onMouseLeave={() => {
          setHovered(false);
        }}
        onFocus={() => {
          setHovered(true);
        }}
        onBlur={() => {
          setHovered(false);
        }}
        className={cn(
          "group flex w-full flex-col gap-2 rounded-md border bg-bg-0 p-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
          selected
            ? "border-transparent ring-2 ring-accent"
            : "border-border hover:border-border-hover",
        )}
        aria-label={
          selection === undefined
            ? `${named}. Open the clip.`
            : selection.selectable
              ? `${named}. Pick for the download.`
              : `${named}. Not made yet.`
        }
      >
        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-sm border border-border bg-ink">
          {state === "ready" && hovered && playUrl !== undefined ? (
            <video
              src={playUrl}
              muted
              autoPlay
              loop
              playsInline
              preload="metadata"
              className="size-full object-cover"
              aria-hidden="true"
              data-testid={`clip-tile-video-${candidate.id}`}
            />
          ) : poster !== undefined ? (
            // A signed object URL: not an asset Next can optimise.
            <img
              src={poster}
              alt=""
              loading="lazy"
              className="size-full object-cover"
              data-testid={`clip-tile-poster-${candidate.id}`}
            />
          ) : state === "ready" && playUrl !== undefined ? (
            <video
              src={`${playUrl}#t=1.2`}
              muted
              playsInline
              preload="metadata"
              className="size-full object-cover"
              aria-hidden="true"
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-xs text-fg-2">
              {state === "failed" ? (
                <AlertTriangle
                  className="size-5 text-rejected"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              ) : state === "waiting" ? (
                <Clock className="size-5" strokeWidth={1.75} aria-hidden="true" />
              ) : state === "cutting" ? (
                <Loader2 className="size-5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Play className="size-5" strokeWidth={1.75} aria-hidden="true" />
              )}
              <span>
                {state === "failed"
                  ? "Could not be made"
                  : state === "waiting"
                    ? "Waiting its turn"
                    : state === "cutting"
                      ? "Being made…"
                      : "Not made yet"}
              </span>
            </div>
          )}
          {selection === undefined ? (
            <span className="absolute left-1.5 top-1.5 rounded-sm bg-ink/80 px-1.5 py-0.5 font-mono text-2xs text-fg-1">
              #{String(rank)}
            </span>
          ) : (
            <span
              className={cn(
                "absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-sm border",
                selected ? "border-accent bg-accent text-ink" : "border-fg-1 bg-ink/80",
              )}
              aria-hidden="true"
              data-testid={`clip-tile-check-${candidate.id}`}
            >
              {selected ? <Check className="size-4" strokeWidth={2.5} /> : null}
            </span>
          )}
          {score === undefined || score === null ? null : (
            <span
              className={cn(
                "absolute right-1.5 top-1.5 rounded-sm bg-ink/80 px-1.5 py-0.5 font-display text-lg leading-none",
                scoreTone(score),
              )}
              data-testid={`clip-tile-score-${candidate.id}`}
            >
              {String(score)}
            </span>
          )}
          <span
            className={cn(
              "absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-2xs font-medium backdrop-blur-xs",
              hookCat.category === "viral" && "border border-emerald-500/40 bg-emerald-950/85 text-emerald-300",
              hookCat.category === "strong" && "border border-sky-500/40 bg-sky-950/85 text-sky-300",
              hookCat.category === "needs_hook" && "border border-amber-500/40 bg-amber-950/85 text-amber-300",
            )}
            title={`${hookCat.label}: ${hookCat.description}`}
            data-testid={`clip-tile-hook-category-${candidate.id}`}
          >
            {hookCat.category === "viral"
              ? `🔥 Viral ${String(hookCat.score)}%`
              : hookCat.category === "strong"
                ? `⚡ Strong ${String(hookCat.score)}%`
                : "🛠️ Needs hook"}
          </span>
          <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-ink/80 px-1.5 py-0.5 font-mono text-2xs text-fg-1">
            {formatClock(durationS * 1000)}
          </span>
        </div>
        <p className="m-0 line-clamp-2 text-sm font-medium text-fg-0">{title}</p>
        {tags.length === 0 ? null : (
          <span className="flex flex-wrap gap-1" data-testid={`clip-tile-tags-${candidate.id}`}>
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-sm border border-border bg-bg-2 px-1.5 py-0.5 text-2xs text-fg-1"
              >
                {tag}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}
