"use client";

/**
 * A run's clips, as a library (2026-10-01, from OpusClip's clip grid): a
 * search box ("Find a clip by its words…"), best-first or in the video's
 * order, a grid of compact tiles or the list of full cards, and a clip opened
 * in place (`ClipDetailDialog`) with the next one a key away.
 *
 * The grid is where a run with several finished clips opens: thirty full cards
 * one under another bury the one a person is looking for. A run with only a
 * few, and every run while clips are being picked for a compilation (the cards
 * carry the tick boxes), shows the list. The choice is remembered per browser.
 *
 * A link to one clip (`#clip-<id>`, a review notification's) opens that clip.
 */
import { LayoutGrid, List, Search, X } from "lucide-react";
import * as React from "react";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";
import { Button, Input, cn } from "@montaj/ui";

import { matchesSearch } from "./clip-analysis";
import { ClipDetailDialog, type ClipEntry } from "./ClipDetailDialog";
import { ClipTile } from "./ClipTile";

import { isRemovedCandidate } from "@/components/repurpose/steering";

export type ResultsView = "grid" | "list";
export type ResultsOrder = "best" | "time";

const VIEW_KEY = "aksharo.repurpose.view";
/** A run opens on the grid from this many finished clips. */
export const GRID_FROM_READY = 4;

function recallView(): ResultsView | null {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    return value === "grid" || value === "list" ? value : null;
  } catch {
    return null;
  }
}

function rememberView(view: ResultsView): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private mode or storage off: the choice lasts this visit.
  }
}

export interface RunClipResultsProps {
  readonly runId: string;
  readonly candidates: readonly RepurposeCandidateItem[];
  readonly clips: readonly RepurposeClipItem[];
  /** Clips are being picked for a compilation: the list, whose cards carry the tick boxes. */
  readonly picking: boolean;
  /** Editors and up may rename a clip. */
  readonly canEdit: boolean;
  /**
   * The run page's full card for a moment; in the list, `onOpenDetails` opens
   * the clip's detail view from the card.
   */
  readonly renderCard: (
    candidate: RepurposeCandidateItem,
    options: { readonly onOpenDetails?: () => void },
  ) => React.ReactNode;
}

export function RunClipResults({
  runId,
  candidates,
  clips,
  picking,
  canEdit,
  renderCard,
}: RunClipResultsProps): React.JSX.Element {
  const clipOf = React.useCallback(
    (candidateId: string) => clips.find((clip) => clip.candidateId === candidateId),
    [clips],
  );
  const kept = candidates.filter((candidate) => !isRemovedCandidate(candidate));
  const readyCount = clips.filter((clip) => clip.state === "ready").length;
  const [chosenView, setChosenView] = React.useState<ResultsView | null>(null);
  React.useEffect(() => {
    setChosenView(recallView());
  }, []);
  const view: ResultsView = picking
    ? "list"
    : (chosenView ?? (readyCount >= GRID_FROM_READY ? "grid" : "list"));
  const [order, setOrder] = React.useState<ResultsOrder>("best");
  const [query, setQuery] = React.useState("");
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);

  // Rank by score, best first: "#1" is the strongest moment whatever the order shown.
  const rankOf = React.useMemo(() => {
    const ranked = [...kept].sort(
      (a, b) => (b.potentialScore ?? b.score ?? -1) - (a.potentialScore ?? a.score ?? -1),
    );
    return new Map(ranked.map((candidate, index) => [candidate.id, index + 1]));
  }, [kept]);

  const searching = query.trim() !== "";
  const shown = kept
    .filter((candidate) => matchesSearch(candidate, query))
    .sort((a, b) =>
      order === "time" ? a.startMs - b.startMs : (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0),
    );
  const entries: ClipEntry[] = shown.map((candidate) => ({
    candidate,
    clip: clipOf(candidate.id),
    rank: rankOf.get(candidate.id) ?? 0,
  }));

  // A link to one clip opens it, once the clips have loaded.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current || view !== "grid" || entries.length === 0) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#clip-")) return;
    const index = entries.findIndex((entry) => entry.clip?.id === hash.slice("#clip-".length));
    if (index < 0) return;
    opened.current = true;
    setOpenIndex(index);
  }, [view, entries]);

  // The list keeps a removed moment folded, for "Restore"; a search shows only matches.
  const listed = searching
    ? shown
    : order === "time"
      ? [...candidates].sort((a, b) => a.startMs - b.startMs)
      : [...shown, ...candidates.filter((candidate) => isRemovedCandidate(candidate))];

  return (
    <div className="flex flex-col gap-3" data-testid="clip-results">
      {kept.length < 2 ? null : (
        <div className="flex flex-wrap items-center gap-2" data-testid="clip-results-toolbar">
          <div role="search" className="relative min-w-0 flex-[1_1_240px]">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-2"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Find a clip by its words, topic or a name…"
              aria-label="Find a clip"
              className="pl-8"
              data-testid="clip-results-search"
            />
          </div>
          <select
            value={order}
            onChange={(event) => {
              setOrder(event.target.value === "time" ? "time" : "best");
            }}
            aria-label="Order"
            className="h-11 rounded-sm border border-neutral-600 bg-sunken px-3 text-sm text-fg-0 sm:h-9"
            data-testid="clip-results-order"
          >
            <option value="best">Best first</option>
            <option value="time">In video order</option>
          </select>
          {picking ? null : (
            <div
              className="flex overflow-hidden rounded-sm border border-border"
              role="group"
              aria-label="View"
            >
              {(["grid", "list"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  aria-label={option === "grid" ? "Grid" : "List"}
                  title={option === "grid" ? "Grid" : "List"}
                  onClick={() => {
                    setChosenView(option);
                    rememberView(option);
                  }}
                  className={cn(
                    "flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9",
                    view === option ? "bg-bg-2 text-fg-0" : "text-fg-2 hover:text-fg-0",
                  )}
                  data-testid={`clip-results-view-${option}`}
                >
                  {option === "grid" ? (
                    <LayoutGrid className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <List className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {searching ? (
        <p
          className="m-0 flex items-center gap-2 text-sm text-fg-1"
          role="status"
          data-testid="clip-results-count"
        >
          {shown.length === 0
            ? `No clip matches “${query.trim()}”.`
            : `${String(shown.length)} ${shown.length === 1 ? "clip matches" : "clips match"} “${query.trim()}”`}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
            }}
          >
            <X strokeWidth={1.75} aria-hidden="true" />
            Clear
          </Button>
        </p>
      ) : null}

      {view === "grid" ? (
        <ul
          className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          data-testid="clip-grid"
        >
          {entries.map((entry, index) => (
            <ClipTile
              key={entry.candidate.id}
              candidate={entry.candidate}
              clip={entry.clip}
              rank={entry.rank}
              onOpen={() => {
                setOpenIndex(index);
              }}
            />
          ))}
        </ul>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="candidates-list">
          {listed.map((candidate) => {
            const index = entries.findIndex((entry) => entry.candidate.id === candidate.id);
            return (
              <React.Fragment key={candidate.id}>
                {renderCard(
                  candidate,
                  index < 0
                    ? {}
                    : {
                        onOpenDetails: () => {
                          setOpenIndex(index);
                        },
                      },
                )}
              </React.Fragment>
            );
          })}
        </ul>
      )}

      <ClipDetailDialog
        runId={runId}
        entries={entries}
        index={openIndex}
        onIndexChange={setOpenIndex}
        canEdit={canEdit}
        renderCard={(entry) => renderCard(entry.candidate, {})}
      />
    </div>
  );
}
