"use client";

/**
 * One caption's row in the transcript list: the speaker chip, its word chips,
 * and the segment-level actions — hide and merge-with-next as buttons on the
 * card itself, and everything else on the card's right-click menu (OC3):
 * split, merge, emphasise, hide/show, insert word after, fix spelling
 * everywhere and delete word. Split (`S`), merge (`M`), emphasise (`E`) and
 * delete word (`Del`) are also the document-wide keyboard map
 * (`useKeyboardShortcuts.ts`) acting on whichever word or segment
 * `onSelect`/`onSelectWord` last reported — one shortcut, one place it fires,
 * regardless of which chip has DOM focus.
 *
 * Every action is a callback, not an op: the editor page is what turns "the
 * user pressed M" into `EditorStore.submitOp`, which is what keeps this
 * component testable without a store. The context menu holds to that rule
 * too — it calls the very callbacks the buttons and the keyboard map call, so
 * click, shortcut and right-click can never drift apart.
 */
import { ArrowDown, Eye, EyeOff, Grid2X2 } from "lucide-react";
import { memo, useCallback, useState } from "react";

import type { Segment, Word } from "@montaj/edg";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@montaj/ui";

import { SpeakerChip } from "./SpeakerChip";
import { WordChip, isWordDisplayScript } from "./WordChip";

import { cn } from "@/lib/utils";

/** What the card asks the editor to do on its behalf — see `onRequestAction`. */
export type SegmentCardAction = "split" | "emphasize" | "deleteWord" | "style";

export interface SegmentCardProps {
  readonly segment: Segment;
  /** design/06 §3.1's row index (`1`, `2`, `3`...) — display only, one-based. */
  readonly index: number;
  readonly words: readonly Word[];
  /**
   * A22's `ScriptTabs` offers `"translated"` alongside the three word-level
   * scripts (`roman`/`native`/`en`) - it is a segment-level caption, not a
   * per-word one (`segment.textOverrides.translated`, `packages/edg`
   * README), so this widens to `string` and branches below rather than
   * forcing every caller through `DisplayScript`.
   */
  readonly script: string;
  readonly speakerName?: string;
  readonly speakerColor?: string;
  readonly selected?: boolean;
  readonly selectedWordId?: string;
  readonly activeWordId?: string;
  readonly hideFillers?: boolean;
  readonly isLast?: boolean;
  readonly onSelect?: (segmentId: string) => void;
  readonly onSelectWord?: (segmentId: string, wordId: string) => void;
  readonly onSeek?: (ms: number) => void;
  readonly onEditWord: (wordId: string, text: string) => void;
  readonly onFixSpellingEverywhere?: (wordId: string, text: string) => void;
  readonly onMergeWithNext?: (segmentId: string) => void;
  readonly onHideToggle?: (segmentId: string, hidden: boolean) => void;
  readonly onInsertWordAfter: (afterWordId: string, text: string) => void;
  readonly onRenameSpeakerRequested?: (speakerId: string) => void;
  /**
   * OC3: split, emphasise and delete-word are owned by the editor page, not by
   * this card — they are `EditorStore` ops that need the whole document — so
   * the menu asks for them by name instead of inventing a local
   * implementation. The editor selects the reported segment/word and then runs
   * the same handler its keyboard map runs.
   */
  readonly onRequestAction?: (
    action: SegmentCardAction,
    segmentId: string,
    wordId?: string,
  ) => void;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The text a chip is currently showing — `WordChip`'s own
 * `word.scripts[script] ?? word.t` rule, spelled out per script so this needs
 * no bracket access on a variable key. "Fix spelling everywhere" propagates
 * exactly what the user can see, which is what a double-click on the chip
 * already sends.
 */
function displayText(word: Word, script: string): string {
  if (script === "roman") return word.scripts?.roman ?? word.t;
  if (script === "native") return word.scripts?.native ?? word.t;
  if (script === "en") return word.scripts?.en ?? word.t;
  return word.t;
}

/**
 * Memoised so a scroll frame that re-renders `TranscriptList` (a `range`
 * state update) does not also re-render every already-mounted, unchanged
 * card underneath it — the overlap between one frame's visible window and
 * the next (most of a "natural" wheel scroll; less of the adversarial
 * whole-list-jump perf test, where nearly every row really is new). Relies
 * on `words` being a stable reference per segment id (`TranscriptList`'s
 * `getWords` cache) and on every callback prop being stable from the parent
 * — both already true here, so the default shallow prop comparison is
 * enough; no custom comparator needed.
 */
export const SegmentCard = memo(SegmentCardImpl);

function SegmentCardImpl({
  segment,
  index,
  words,
  script,
  speakerName,
  speakerColor,
  selected = false,
  selectedWordId,
  activeWordId,
  hideFillers = false,
  isLast = false,
  onSelect,
  onSelectWord,
  onSeek,
  onEditWord,
  onFixSpellingEverywhere,
  onMergeWithNext,
  onHideToggle,
  onInsertWordAfter,
  onRenameSpeakerRequested,
  onRequestAction,
}: SegmentCardProps): React.JSX.Element {
  // Which word the pointer was over when the menu was summoned. Set on the
  // right button's `pointerdown` — dispatched before the `contextmenu` radix
  // listens for — and cleared when the menu closes, so a keyboard-summoned
  // menu (Shift+F10) never inherits a stale target.
  const [contextWordId, setContextWordId] = useState<string | undefined>(undefined);
  const speakerId = words[0]?.sp ?? segment.id;
  // Looked up in *this card's* words on purpose: `selectedWordId` is handed to
  // every card in the list, so falling back to it without the lookup would let
  // one card offer word actions for a word belonging to another segment.
  const menuWord = words.find((word) => word.wid === (contextWordId ?? selectedWordId));
  const noWord = menuWord === undefined;
  // Stable per segment (recreated only when `SegmentCardImpl` itself
  // re-renders, which memoisation above already limits) so `WordChip`'s own
  // `React.memo` is not defeated by a fresh closure on every word every time.
  const handleWordSelect = useCallback(
    (wordId: string) => {
      onSelectWord?.(segment.id, wordId);
    },
    [segment.id, onSelectWord],
  );

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          setContextWordId(undefined);
          return;
        }
        // The side-effect the replaced handler had was "act on what was
        // right-clicked": its word half is `contextWordId` above, and its
        // segment half is the same selection a left-click on the card makes.
        onSelect?.(segment.id);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          data-testid={`segment-card-${segment.id}`}
          data-segment-id={segment.id}
          role="group"
          aria-label={`Caption starting at ${formatTimestamp(segment.startMs)}`}
          className={cn(
            "editor-caption-row group relative flex min-h-[58px] items-center gap-3.5 border-b py-2 transition-colors duration-[160ms]",
            selected ? "is-selected" : "",
            // Dimmed, not faded out: at 60 % the words still clear 4.5:1 on the panel.
            segment.hidden === true && "opacity-60",
          )}
          onClick={() => onSelect?.(segment.id)}
        >
          {/* design/06 §3.1 item 1: the row's line index, muted gray. */}
          <span
            aria-hidden="true"
            className="text-fg-2 w-[22px] shrink-0 text-xs tabular-nums"
          >
            {index}
          </span>

          <button
            type="button"
            data-testid={`segment-timestamp-${segment.id}`}
            title="Seek to this caption"
            className="editor-caption-timestamp text-fg-2 hover:text-fg-0 font-mono text-2xs tabular-nums"
            onClick={(event) => {
              event.stopPropagation();
              onSeek?.(segment.startMs);
            }}
          >
            {formatTimestamp(segment.startMs)}
          </button>

          {isWordDisplayScript(script) ? (
            <div
              className="editor-caption-words flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1 text-[15px] leading-6"
              data-testid={`segment-words-${segment.id}`}
            >
              {words.map((word) => (
                <span
                  key={word.wid}
                  onPointerDown={(event) => {
                    if (event.button === 2) setContextWordId(word.wid);
                  }}
                >
                  <WordChip
                    word={word}
                    script={script}
                    active={word.wid === activeWordId}
                    selected={word.wid === selectedWordId}
                    emphasized={
                      word.isEmphasized === true ||
                      segment.emphasis?.some((entry) => entry.wordId === word.wid) === true
                    }
                    hideFillers={hideFillers}
                    onCommit={onEditWord}
                    {...(onSeek === undefined ? {} : { onSeek })}
                    {...(onFixSpellingEverywhere === undefined ? {} : { onFixSpellingEverywhere })}
                    onSelect={handleWordSelect}
                  />
                </span>
              ))}
            </div>
          ) : (
            <p
              className="text-fg-2 min-w-0 flex-1 pt-1 text-xs italic"
              data-testid={`segment-translated-${segment.id}`}
            >
              {segment.textOverrides?.["translated"] ??
                "(no translation yet — use +Add translation above)"}
            </p>
          )}

          {/* design/06 §3.1 item 3: the row's two action icons. */}
          <div className="editor-caption-actions ml-auto flex shrink-0 items-center gap-2 pr-4">
            <SpeakerChip
              speakerId={speakerId}
              name={speakerName}
              color={speakerColor}
              {...(onRenameSpeakerRequested === undefined
                ? {}
                : { onRenameRequested: onRenameSpeakerRequested })}
            />
            <button
              type="button"
              className="text-fg-2 hover:text-fg-0 flex size-6 items-center justify-center rounded-sm"
              aria-label="Caption style"
              title="Caption style"
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(segment.id);
                onRequestAction?.("style", segment.id);
              }}
            >
              <Grid2X2 className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid={`segment-hide-${segment.id}`}
              aria-label={segment.hidden === true ? "Show caption" : "Hide caption"}
              title={segment.hidden === true ? "Show caption" : "Hide caption"}
              className={cn(
                "editor-caption-hide text-fg-2 hover:text-fg-0 hover:bg-bg-2 flex size-6 items-center justify-center rounded-sm transition-[color,background-color,opacity] duration-[160ms]",
                // Kalakar's own row (pixel-sampled 2026-09-12) shows two
                // persistent icons, not three — this one is also on the
                // right-click menu (`segment-menu-hide`), so a hover reveal
                // loses no functionality, only default visual weight.
                // "Show" stays persistent: a segment already in the less-
                // common hidden state (the row itself dims) needs an
                // obvious way back, not one more thing to discover on hover.
                segment.hidden === true
                  ? "opacity-100"
                  : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
              )}
              onClick={(event) => {
                event.stopPropagation();
                onHideToggle?.(segment.id, segment.hidden !== true);
              }}
            >
              {segment.hidden === true ? (
                <EyeOff className="size-3.5" aria-hidden="true" />
              ) : (
                <Eye className="size-3.5" aria-hidden="true" />
              )}
            </button>
            {isLast ? null : (
              <button
                type="button"
                data-testid={`segment-merge-next-${segment.id}`}
                aria-label="Merge with next"
                title="Merge with next (M)"
                className="editor-caption-merge text-fg-2 hover:text-fg-0 hover:bg-bg-2 flex size-6 items-center justify-center rounded-sm transition-colors duration-[160ms]"
                onClick={(event) => {
                  event.stopPropagation();
                  onMergeWithNext?.(segment.id);
                }}
              >
                <ArrowDown className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent data-testid="segment-context-menu">
        <ContextMenuItem
          data-testid="segment-menu-split"
          disabled={noWord || onRequestAction === undefined}
          onSelect={() => {
            if (menuWord !== undefined) onRequestAction?.("split", segment.id, menuWord.wid);
          }}
        >
          Split here <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="segment-menu-merge"
          disabled={isLast || onMergeWithNext === undefined}
          onSelect={() => onMergeWithNext?.(segment.id)}
        >
          Merge with next <ContextMenuShortcut>M</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="segment-menu-emphasise"
          disabled={noWord || onRequestAction === undefined}
          onSelect={() => {
            if (menuWord !== undefined) onRequestAction?.("emphasize", segment.id, menuWord.wid);
          }}
        >
          Emphasise word <ContextMenuShortcut>E</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          data-testid="segment-menu-hide"
          disabled={onHideToggle === undefined}
          onSelect={() => onHideToggle?.(segment.id, segment.hidden !== true)}
        >
          {segment.hidden === true ? "Show segment" : "Hide segment"}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="segment-menu-insert-word"
          disabled={noWord}
          onSelect={() => {
            if (menuWord === undefined) return;
            const text = window.prompt("Insert word after this one:", "");
            if (text !== null && text.trim() !== "") onInsertWordAfter(menuWord.wid, text.trim());
          }}
        >
          Insert word after…
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="segment-menu-fix-spelling"
          disabled={noWord || onFixSpellingEverywhere === undefined}
          onSelect={() => {
            if (menuWord !== undefined)
              onFixSpellingEverywhere?.(menuWord.wid, displayText(menuWord, script));
          }}
        >
          Fix spelling everywhere…
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          variant="destructive"
          data-testid="segment-menu-delete-word"
          disabled={noWord || onRequestAction === undefined}
          onSelect={() => {
            if (menuWord !== undefined) onRequestAction?.("deleteWord", segment.id, menuWord.wid);
          }}
        >
          Delete word <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

SegmentCardImpl.displayName = "SegmentCardImpl";
