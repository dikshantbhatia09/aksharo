"use client";

/**
 * The editor's B-roll tab (2026-10-05): the clip's cutaways, and a way to add
 * one where the playhead is.
 *
 * A cutaway is a still picture over the words that name what it shows - full
 * frame or picture in picture, with a slow push-in or pan, fading in and out,
 * captions always on top. This panel only builds the overlay; the document
 * keeps it (`SetOverlay`), render-core draws it everywhere, and the editor's
 * undo takes any change back.
 *
 * - **Add** puts the chosen picture over the word under the playhead and the
 *   next few, about two and a half seconds (`brollWindowFrom`), from the
 *   workspace's library, or from a stock photo search where the deployment
 *   has one (the photo is kept in the library first).
 * - **Move and trim** go a word at a time (`nudgeBrollWindow`), so a cutaway
 *   always starts and ends with a word.
 * - Neither may put a cutaway over the hook's first seconds, a hook title or
 *   an end card (`brollPlacementProblem`): the button that would is disabled,
 *   and says why.
 */
import { ArrowLeft, ArrowRight, ImageOff, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  nudgeBrollWindow,
  type BRollMode,
  type BRollMotion,
  type BRollOverlay,
  type BrollPlacementProblem,
  type BrollSpan,
} from "@montaj/edg";
import { Button, Input, cn } from "@montaj/ui";

import {
  useSaveStockPhoto,
  useStockSearch,
  type BrollLibraryView,
  type BrollPicture,
  type StockOrientation,
} from "@/components/broll/use-broll-library";
import { messageForError } from "@/lib/errors";

/** A word that plays, as the panel reads it. */
export interface BrollPanelWord {
  readonly wid: string;
  readonly t: string;
  readonly s: number;
  readonly e: number;
}

export interface BrollPanelProps {
  readonly cutaways: readonly BRollOverlay[];
  /** The words that play, in order: labels, and moving a cutaway a word at a time. */
  readonly words: readonly BrollPanelWord[];
  /** Where "Add" puts a cutaway (the word under the playhead), and why it cannot, if it cannot. */
  readonly addAt?: {
    readonly word: string;
    readonly startMs: number;
    readonly problem?: BrollPlacementProblem;
  };
  readonly library: BrollLibraryView | null | undefined;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly canEdit: boolean;
  /** Why a cutaway cannot go at `window` (`brollPlacementProblem` with the editor's clock). */
  readonly placementProblem: (window: BrollSpan) => BrollPlacementProblem | undefined;
  readonly onAdd: (picture: BrollPicture) => void;
  readonly onChange: (overlay: BRollOverlay, label: string) => void;
  readonly onRemove: (overlay: BRollOverlay) => void;
  readonly onSeek: (ms: number) => void;
  readonly className?: string;
}

const MOTIONS: readonly { readonly value: BRollMotion; readonly label: string }[] = [
  { value: "push-in", label: "Push in" },
  { value: "pull-out", label: "Pull out" },
  { value: "pan-left", label: "Pan left" },
  { value: "pan-right", label: "Pan right" },
  { value: "none", label: "Still" },
];

const MODES: readonly { readonly value: BRollMode; readonly label: string }[] = [
  { value: "full", label: "Full frame" },
  { value: "pip", label: "Picture in picture" },
];

const PROBLEM_COPY: Readonly<Record<BrollPlacementProblem, string>> = {
  hook: "Not over the first seconds: they are the hook's.",
  title: "Not over a title card or the end card.",
};

const SELECT_CLASS = "bg-sunken border-neutral-600 text-fg-0 h-8 rounded-sm border px-2 text-xs";

/** `m:ss.s`, the way the timeline reads a time. */
export function brollTime(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function orientationOf(canvas: BrollPanelProps["canvas"]): StockOrientation {
  if (canvas.height > canvas.width * 1.1) return "portrait";
  if (canvas.width > canvas.height * 1.1) return "landscape";
  return "square";
}

/** The words a window covers, as said. */
function wordsIn(words: readonly BrollPanelWord[], window: BrollSpan): string {
  return words
    .filter((word) => word.s >= window.startMs && word.s < window.endMs)
    .map((word) => word.t)
    .join(" ");
}

/** The first and last word ids of a window, for the overlay's own record. */
function wordIdsOf(
  words: readonly BrollPanelWord[],
  window: BrollSpan,
): { readonly startWordId?: string; readonly endWordId?: string } {
  const inside = words.filter((word) => word.s >= window.startMs && word.s < window.endMs);
  const first = inside.at(0);
  const last = inside.at(-1);
  return {
    ...(first === undefined ? {} : { startWordId: first.wid }),
    ...(last === undefined ? {} : { endWordId: last.wid }),
  };
}

export function BrollPanel(props: BrollPanelProps): React.JSX.Element {
  const { cutaways, library, canEdit, addAt, className } = props;
  const pictures = library?.items ?? [];
  const byId = new Map(pictures.map((picture) => [picture.assetId, picture]));
  const [source, setSource] = React.useState<"library" | "stock">("library");
  const stockEnabled = library?.stock.enabled === true;
  const addProblem =
    addAt === undefined
      ? "Put the playhead on a word to add a picture there."
      : addAt.problem === undefined
        ? undefined
        : PROBLEM_COPY[addAt.problem];

  return (
    <div
      className={cn("flex h-full flex-col gap-4 overflow-y-auto", className)}
      data-testid="broll-panel"
    >
      <section className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-sm font-medium">B-roll</h2>
        <p className="text-fg-2 m-0 text-xs">
          A picture cut away to over the words that name it: a still picture with a slow push-in or
          pan. Captions stay on top.
        </p>
      </section>

      <section className="flex flex-col gap-2" data-testid="broll-add">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-fg-0 m-0 text-xs font-medium">
            {addAt === undefined
              ? "Add a picture"
              : `Add at “${addAt.word}” ${brollTime(addAt.startMs)}`}
          </h3>
          {stockEnabled ? (
            <div className="flex gap-1" role="tablist" aria-label="Where the picture comes from">
              {(["library", "stock"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={source === value}
                  className={cn(
                    "text-fg-2 hover:text-fg-0 border-b-2 border-transparent px-1 pb-0.5 text-xs",
                    source === value && "border-accent text-fg-0",
                  )}
                  onClick={() => {
                    setSource(value);
                  }}
                  data-testid={`broll-source-${value}`}
                >
                  {value === "library" ? "Your library" : "Stock photos"}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {addProblem === undefined ? null : (
          <p className="text-fg-2 m-0 text-xs" data-testid="broll-add-problem">
            {addProblem}
          </p>
        )}
        {source === "stock" && stockEnabled ? (
          <StockPicker
            canvas={props.canvas}
            disabled={!canEdit || addProblem !== undefined}
            onPick={props.onAdd}
          />
        ) : (
          <LibraryPicker
            pictures={pictures}
            disabled={!canEdit || addProblem !== undefined}
            onPick={props.onAdd}
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-fg-0 m-0 text-xs font-medium">
          {cutaways.length === 0
            ? "No cutaways in this clip"
            : `In this clip (${String(cutaways.length)})`}
        </h3>
        {cutaways.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="broll-cutaways">
            {cutaways.map((cutaway) => (
              <CutawayRow
                key={cutaway.id}
                cutaway={cutaway}
                picture={byId.get(cutaway.image.assetId)}
                libraryLoaded={library !== undefined && library !== null}
                {...props}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function LibraryPicker({
  pictures,
  disabled,
  onPick,
}: {
  readonly pictures: readonly BrollPicture[];
  readonly disabled: boolean;
  readonly onPick: (picture: BrollPicture) => void;
}): React.JSX.Element {
  const [filter, setFilter] = React.useState("");
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ""
      ? pictures
      : pictures.filter(
          (picture) =>
            picture.tags.some((tag) => tag.includes(needle)) ||
            (picture.title ?? "").toLowerCase().includes(needle),
        );
  if (pictures.length === 0) {
    return (
      <p className="text-fg-2 m-0 text-xs" data-testid="broll-library-empty">
        Your B-roll library is empty.{" "}
        <Link href="/settings/broll" className="text-accent-300 underline underline-offset-4">
          Add pictures
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="broll-library-filter" className="sr-only">
        Find a picture
      </label>
      <Input
        id="broll-library-filter"
        value={filter}
        placeholder="Find by tag"
        onChange={(event) => {
          setFilter(event.target.value);
        }}
        data-testid="broll-library-filter"
      />
      <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0" data-testid="broll-library-pictures">
        {shown.map((picture) => (
          <li key={picture.assetId}>
            <button
              type="button"
              disabled={disabled}
              className="border-border hover:border-accent focus-visible:border-accent block w-full overflow-hidden rounded-sm border disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`Add ${picture.title ?? picture.tags.join(", ")}`}
              onClick={() => {
                onPick(picture);
              }}
              data-testid={`broll-pick-${picture.assetId}`}
            >
              <img src={picture.url} alt="" className="aspect-square w-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StockPicker({
  canvas,
  disabled,
  onPick,
}: {
  readonly canvas: BrollPanelProps["canvas"];
  readonly disabled: boolean;
  readonly onPick: (picture: BrollPicture) => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const [query, setQuery] = React.useState("");
  const search = useStockSearch(query, orientationOf(canvas), true);
  const save = useSaveStockPhoto();
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <form
        role="search"
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <label htmlFor="broll-stock-query-editor" className="sr-only">
          Search stock photos
        </label>
        <Input
          id="broll-stock-query-editor"
          value={draft}
          placeholder="What should it show?"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          data-testid="broll-editor-stock-query"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={draft.trim().length < 2}
          aria-label="Search stock photos"
          data-testid="broll-editor-stock-search"
        >
          <Search aria-hidden="true" strokeWidth={1.75} />
        </Button>
      </form>
      {problem === null && !search.isError ? null : (
        <p role="alert" className="text-rejected m-0 text-xs">
          {problem ?? messageForError(search.error)}
        </p>
      )}
      {search.data === undefined ? null : search.data.photos.length === 0 ? (
        <p className="text-fg-2 m-0 text-xs">No photos found. Try other words.</p>
      ) : (
        <ul
          className="m-0 grid list-none grid-cols-3 gap-2 p-0"
          data-testid="broll-editor-stock-results"
        >
          {search.data.photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                disabled={disabled || save.isPending}
                className="border-border hover:border-accent block w-full overflow-hidden rounded-sm border disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={`Add a photo by ${photo.photographer}`}
                onClick={() => {
                  setProblem(null);
                  save.mutate(
                    { photoId: photo.id, tags: query === "" ? [] : [query.toLowerCase()] },
                    {
                      onSuccess: onPick,
                      onError: (error) => {
                        setProblem(messageForError(error));
                      },
                    },
                  );
                }}
                data-testid={`broll-editor-stock-pick-${String(photo.id)}`}
              >
                <img src={photo.previewUrl} alt="" className="aspect-square w-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-fg-2 m-0 text-2xs">
        {"Photos provided by "}
        <a
          href="https://www.pexels.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg-1 underline"
        >
          Pexels
        </a>
      </p>
    </div>
  );
}

function CutawayRow({
  cutaway,
  picture,
  libraryLoaded,
  words,
  canEdit,
  placementProblem,
  onChange,
  onRemove,
  onSeek,
}: BrollPanelProps & {
  readonly cutaway: BRollOverlay;
  readonly picture: BrollPicture | undefined;
  readonly libraryLoaded: boolean;
}): React.JSX.Element {
  const said = wordsIn(words, cutaway);
  const label = cutaway.label ?? (said === "" ? "Cutaway" : said);
  /** A move or trim, when it keeps to the words and off the hook and the cards. */
  const nudge = (edge: "start" | "end" | "both", direction: -1 | 1) => {
    const next = nudgeBrollWindow(cutaway, words, edge, direction);
    if (next === undefined || placementProblem(next) !== undefined) return undefined;
    return next;
  };
  const apply = (window: BrollSpan | undefined, what: string) => {
    if (window === undefined) return;
    const { startWordId: _start, endWordId: _end, ...rest } = cutaway;
    onChange({ ...rest, ...window, ...wordIdsOf(words, window) } as BRollOverlay, what);
  };
  const moves = [
    { key: "earlier", label: "Earlier", window: nudge("both", -1), icon: ArrowLeft },
    { key: "later", label: "Later", window: nudge("both", 1), icon: ArrowRight },
  ] as const;
  const trims = [
    { key: "start-earlier", label: "Start earlier", window: nudge("start", -1) },
    { key: "start-later", label: "Start later", window: nudge("start", 1) },
    { key: "end-earlier", label: "End earlier", window: nudge("end", -1) },
    { key: "end-later", label: "End later", window: nudge("end", 1) },
  ] as const;

  return (
    <li
      className="border-border bg-surface flex flex-col gap-2 rounded-md border p-2"
      data-testid={`broll-cutaway-${cutaway.id}`}
    >
      <button
        type="button"
        className="flex items-center gap-2 text-left"
        onClick={() => {
          onSeek(cutaway.startMs);
        }}
        data-testid={`broll-cutaway-seek-${cutaway.id}`}
      >
        {picture === undefined ? (
          <span className="bg-sunken flex size-10 shrink-0 items-center justify-center rounded-sm">
            <ImageOff className="text-fg-2 size-4" aria-hidden="true" />
          </span>
        ) : (
          <img src={picture.url} alt="" className="size-10 shrink-0 rounded-sm object-cover" />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="text-fg-0 truncate text-xs font-medium">{label}</span>
          <span className="text-fg-2 text-2xs font-mono">
            {`${brollTime(cutaway.startMs)}–${brollTime(cutaway.endMs)}`}
          </span>
          {picture === undefined && libraryLoaded ? (
            <span className="text-fg-2 text-2xs" data-testid={`broll-cutaway-gone-${cutaway.id}`}>
              Deleted from your library: it no longer shows.
            </span>
          ) : null}
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="m-0 flex gap-1 border-0 p-0" disabled={!canEdit}>
          <legend className="sr-only">Shown as</legend>
          {MODES.map((mode) => (
            <label
              key={mode.value}
              className={cn(
                "flex h-8 cursor-pointer items-center rounded-sm border px-2 text-xs",
                cutaway.mode === mode.value
                  ? "border-accent text-fg-0"
                  : "text-fg-1 border-neutral-600",
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={`broll-mode-${cutaway.id}`}
                value={mode.value}
                checked={cutaway.mode === mode.value}
                onChange={() => {
                  onChange({ ...cutaway, mode: mode.value }, "Change B-roll size");
                }}
                data-testid={`broll-mode-${mode.value}-${cutaway.id}`}
              />
              {mode.label}
            </label>
          ))}
        </fieldset>
        <label htmlFor={`broll-motion-${cutaway.id}`} className="sr-only">
          Motion
        </label>
        <select
          id={`broll-motion-${cutaway.id}`}
          className={SELECT_CLASS}
          value={cutaway.motion}
          disabled={!canEdit}
          onChange={(event) => {
            onChange(
              { ...cutaway, motion: event.target.value as BRollMotion },
              "Change B-roll motion",
            );
          }}
          data-testid={`broll-motion-${cutaway.id}`}
        >
          {MOTIONS.map((motion) => (
            <option key={motion.value} value={motion.value}>
              {motion.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {moves.map((move) => {
          const Icon = move.icon;
          return (
            <Button
              key={move.key}
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canEdit || move.window === undefined}
              onClick={() => {
                apply(move.window, "Move B-roll");
              }}
              data-testid={`broll-move-${move.key}-${cutaway.id}`}
            >
              <Icon aria-hidden="true" strokeWidth={1.75} />
              {move.label}
            </Button>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={!canEdit}
          onClick={() => {
            onRemove(cutaway);
          }}
          data-testid={`broll-remove-${cutaway.id}`}
        >
          <Trash2 aria-hidden="true" strokeWidth={1.75} />
          Remove
        </Button>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Trim">
        {trims.map((trim) => (
          <Button
            key={trim.key}
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canEdit || trim.window === undefined}
            onClick={() => {
              apply(trim.window, "Trim B-roll");
            }}
            data-testid={`broll-trim-${trim.key}-${cutaway.id}`}
          >
            {trim.label}
          </Button>
        ))}
      </div>
    </li>
  );
}
