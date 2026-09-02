"use client";

/**
 * One caption's row in the transcript list: the speaker chip, its word chips,
 * and the segment-level actions — hide and merge-with-next as buttons on the
 * card itself, and "insert word after" on a word's right-click. Split (`S`),
 * merge (`M`), emphasise (`E`) and delete word (`Del`) are the document-wide
 * keyboard map (`useKeyboardShortcuts.ts`) acting on whichever word or
 * segment `onSelect`/`onSelectWord` last reported — one shortcut, one place
 * it fires, regardless of which chip has DOM focus.
 *
 * Every action is a callback, not an op: the editor page is what turns "the
 * user pressed M" into `EditorStore.submitOp`, which is what keeps this
 * component testable without a store.
 */
import { useState } from "react";

import type { Segment, Word } from "@montaj/edg";

import { SpeakerChip } from "./SpeakerChip";
import { WordChip, isWordDisplayScript } from "./WordChip";

import { cn } from "@/lib/utils";

export interface SegmentCardProps {
  readonly segment: Segment;
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
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function SegmentCard({
  segment,
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
}: SegmentCardProps): React.JSX.Element {
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const speakerId = words[0]?.sp ?? segment.id;

  return (
    <div
      data-testid={`segment-card-${segment.id}`}
      data-segment-id={segment.id}
      role="group"
      aria-label={`Caption starting at ${formatTimestamp(segment.startMs)}`}
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-3 py-2",
        selected ? "border-lime-400/60 bg-white/[0.06]" : "border-white/5 hover:bg-white/[0.03]",
        segment.hidden === true && "opacity-40",
      )}
      onClick={() => onSelect?.(segment.id)}
    >
      <div className="flex items-center gap-2">
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
          data-testid={`segment-timestamp-${segment.id}`}
          className="text-fg-3 shrink-0 font-mono text-xs hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            onSeek?.(segment.startMs);
          }}
        >
          {formatTimestamp(segment.startMs)}
        </button>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            data-testid={`segment-hide-${segment.id}`}
            title={segment.hidden === true ? "Show caption" : "Hide caption"}
            className="text-fg-3 rounded px-1.5 py-0.5 text-xs hover:bg-white/10"
            onClick={(event) => {
              event.stopPropagation();
              onHideToggle?.(segment.id, segment.hidden !== true);
            }}
          >
            {segment.hidden === true ? "Show" : "Hide"}
          </button>
          {isLast ? null : (
            <button
              type="button"
              data-testid={`segment-merge-next-${segment.id}`}
              title="Merge with next (M)"
              className="text-fg-3 rounded px-1.5 py-0.5 text-xs hover:bg-white/10"
              onClick={(event) => {
                event.stopPropagation();
                onMergeWithNext?.(segment.id);
              }}
            >
              Merge ↓
            </button>
          )}
        </div>
      </div>

      {isWordDisplayScript(script) ? (
        <div
          className="flex flex-wrap gap-x-1 gap-y-0.5 text-sm leading-relaxed"
          data-testid={`segment-words-${segment.id}`}
        >
          {words.map((word) => (
            <span
              key={word.wid}
              className="relative"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuFor(word.wid);
              }}
            >
              <WordChip
                word={word}
                script={script}
                active={word.wid === activeWordId}
                selected={word.wid === selectedWordId}
                hideFillers={hideFillers}
                onCommit={onEditWord}
                {...(onSeek === undefined ? {} : { onSeek })}
                {...(onFixSpellingEverywhere === undefined ? {} : { onFixSpellingEverywhere })}
                onSelect={(wordId) => {
                  onSelectWord?.(segment.id, wordId);
                }}
              />
              {menuFor === word.wid ? (
                <span
                  role="menu"
                  data-testid={`word-insert-menu-${word.wid}`}
                  className="absolute top-full left-0 z-10 mt-1 flex gap-1 rounded-md border border-white/10 bg-black p-1 text-xs shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`word-insert-after-${word.wid}`}
                    className="rounded px-2 py-1 hover:bg-white/10"
                    onClick={(event) => {
                      event.stopPropagation();
                      const text = window.prompt("Insert word after this one:", "");
                      setMenuFor(undefined);
                      if (text !== null && text.trim() !== "")
                        onInsertWordAfter(word.wid, text.trim());
                    }}
                  >
                    Insert word after
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="rounded px-2 py-1 hover:bg-white/10"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuFor(undefined);
                    }}
                  >
                    Cancel
                  </button>
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-fg-2 text-sm italic" data-testid={`segment-translated-${segment.id}`}>
          {segment.textOverrides?.["translated"] ??
            "(no translation yet — use +Add translation above)"}
        </p>
      )}
    </div>
  );
}
