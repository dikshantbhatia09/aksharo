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
 *
 * The search finds a clip by its words at once, and by what it is about a
 * moment later (`useRunSearch`, a local embedding model): "how to get rich"
 * finds the compound-interest clip that never says "rich". Word matches come
 * first, then the ones found by meaning, closest first.
 *
 * "Select" (2026-10-01, OpusClip's multi-select): the grid's tiles tick
 * instead of opening, and a bar below them downloads the clips picked as one
 * ZIP (`RunDownloadDialog` with their ids). Only made clips can be picked.
 *
 * Read only (`readOnly`, 2026-10-01: the example run any signed-in person may
 * open, `/repurpose/example`): the same grid, search by words, order and clip
 * view, but no "Select" and no ZIP, no search by meaning, no rename and no
 * editor links - every one of those is a route of the run's own workspace.
 * Each clip still downloads on its own from its card.
 */
import { CheckSquare, Download, LayoutGrid, List, Search, X } from "lucide-react";
import * as React from "react";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";
import { Button, Input, cn } from "@montaj/ui";

import { matchesSearch } from "./clip-analysis";
import { ClipDetailDialog, type ClipEntry, type ReadOnlyClips } from "./ClipDetailDialog";
import { ClipTile } from "./ClipTile";
import { useRunSearch } from "./use-results";

import { RunDownloadDialog } from "@/components/repurpose/download/RunDownloadAll";
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
  /** A run the reader may only look at (the example run): see the file's comment. */
  readonly readOnly?: ReadOnlyClips;
}

export function RunClipResults({
  runId,
  candidates,
  clips,
  picking,
  canEdit,
  renderCard,
  readOnly,
}: RunClipResultsProps): React.JSX.Element {
  const viewOnly = readOnly !== undefined;
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
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const [downloading, setDownloading] = React.useState(false);
  const view: ResultsView = picking
    ? "list"
    : selecting
      ? "grid"
      : (chosenView ?? (readyCount >= GRID_FROM_READY ? "grid" : "list"));
  const readyIds = clips.filter((clip) => clip.state === "ready").map((clip) => clip.id);
  const toggle = (clipId: string): void => {
    setSelected((current) =>
      current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId],
    );
  };
  const stopSelecting = (): void => {
    setSelecting(false);
    setSelected([]);
  };
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
  // The question as it settles: one search by meaning per pause in the typing.
  const [settled, setSettled] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(query.trim());
    }, 350);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);
  const byMeaning = useRunSearch(runId, searching ? settled : "", !viewOnly);
  const meaningOf = new Map(
    byMeaning.data?.semantic === true && settled === query.trim()
      ? byMeaning.data.matches.map((match) => [match.candidateId, match.score] as const)
      : [],
  );
  const byWords = kept
    .filter((candidate) => matchesSearch(candidate, query))
    .sort((a, b) =>
      order === "time" ? a.startMs - b.startMs : (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0),
    );
  const wordIds = new Set(byWords.map((candidate) => candidate.id));
  const related = searching
    ? kept
        .filter((candidate) => !wordIds.has(candidate.id) && meaningOf.has(candidate.id))
        .sort((a, b) => (meaningOf.get(b.id) ?? 0) - (meaningOf.get(a.id) ?? 0))
    : [];
  const shown = [...byWords, ...related];
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
          {picking || viewOnly || readyCount === 0 ? null : (
            <Button
              variant={selecting ? "secondary" : "ghost"}
              size="sm"
              className="h-11 sm:h-9"
              aria-pressed={selecting}
              onClick={() => {
                if (selecting) stopSelecting();
                else setSelecting(true);
              }}
              data-testid="clip-results-select"
            >
              <CheckSquare strokeWidth={1.75} aria-hidden="true" />
              {selecting ? "Done" : "Select"}
            </Button>
          )}
          {picking || selecting ? null : (
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
            ? byMeaning.isFetching
              ? `Looking for clips about “${query.trim()}”…`
              : `No clip matches “${query.trim()}”.`
            : `${String(shown.length)} ${shown.length === 1 ? "clip matches" : "clips match"} “${query.trim()}”${
                related.length === 0
                  ? ""
                  : byWords.length === 0
                    ? " by what it is about"
                    : ` (${String(related.length)} by what ${related.length === 1 ? "it is" : "they are"} about)`
              }`}
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
              {...(selecting
                ? {
                    selection: {
                      selected: entry.clip !== undefined && selected.includes(entry.clip.id),
                      selectable: entry.clip?.state === "ready",
                      onToggle: () => {
                        if (entry.clip !== undefined) toggle(entry.clip.id);
                      },
                    },
                  }
                : {})}
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

      {selecting ? (
        <div
          role="region"
          aria-label="Clips picked"
          className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-2 px-3 py-2 shadow-lg"
          data-testid="clip-selection-bar"
        >
          <span
            className="mr-auto text-sm text-fg-0"
            role="status"
            data-testid="clip-selection-count"
          >
            {selected.length === 0
              ? "Pick the clips to download."
              : selected.length === 1
                ? "1 clip picked"
                : `${String(selected.length)} clips picked`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={selected.length === readyIds.length}
            onClick={() => {
              setSelected(readyIds);
            }}
            data-testid="clip-selection-all"
          >
            Pick all {String(readyIds.length)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={selected.length === 0}
            onClick={() => {
              setSelected([]);
            }}
          >
            Clear
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.length === 0}
            onClick={() => {
              setDownloading(true);
            }}
            data-testid="clip-selection-download"
          >
            <Download strokeWidth={1.75} aria-hidden="true" />
            Download
          </Button>
        </div>
      ) : null}

      {viewOnly ? null : (
        <RunDownloadDialog
          runId={runId}
          clipIds={selected}
          open={downloading}
          onOpenChange={setDownloading}
        />
      )}

      <ClipDetailDialog
        runId={runId}
        entries={entries}
        index={openIndex}
        onIndexChange={setOpenIndex}
        canEdit={canEdit && !viewOnly}
        renderCard={(entry) => renderCard(entry.candidate, {})}
        {...(readOnly === undefined ? {} : { readOnly })}
      />
    </div>
  );
}
