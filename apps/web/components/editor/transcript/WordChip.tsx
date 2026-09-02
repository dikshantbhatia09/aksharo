"use client";

/**
 * One word: contenteditable, low-confidence underlined amber, a filler dimmed
 * (or hidden behind the "hide fillers" toggle), the active word under the
 * playhead highlighted, a click seeks, a double-click fixes the spelling
 * everywhere (08 §4, brief §3).
 *
 * `S`/`M`/`E`/`Del`/`Ctrl+F`/`Ctrl+Z`/`Ctrl+Y` are **not** handled here: they
 * are the document-wide keyboard map (`useKeyboardShortcuts.ts`) acting on
 * whichever word or segment is selected, so a shortcut fires exactly once
 * whether or not a chip happens to have DOM focus. This component only owns
 * entering/leaving its own edit mode (`Enter`/`Escape`/blur) and reporting
 * clicks. Nothing here talks to the network — every callback is a plain prop,
 * which is what keeps it testable with React Testing Library and no store.
 */
import { useEffect, useRef, useState } from "react";

import type { Word } from "@montaj/edg";

import { cn } from "@/lib/utils";

export type DisplayScript = "roman" | "native" | "en";

export interface WordChipProps {
  readonly word: Word;
  readonly script: DisplayScript;
  /** Under the playhead right now. */
  readonly active?: boolean;
  readonly selected?: boolean;
  /** Fillers hidden entirely rather than dimmed, per the toggle. */
  readonly hideFillers?: boolean;
  /** Below this the word is underlined amber (low ASR confidence). */
  readonly confidenceThreshold?: number;
  readonly onCommit: (wordId: string, text: string) => void;
  readonly onSeek?: (ms: number) => void;
  readonly onSelect?: (wordId: string) => void;
  /** Double-click: "Fix spelling everywhere". */
  readonly onFixSpellingEverywhere?: (wordId: string, text: string) => void;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export function WordChip({
  word,
  script,
  active = false,
  selected = false,
  hideFillers = false,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  onCommit,
  onSeek,
  onSelect,
  onFixSpellingEverywhere,
}: WordChipProps): React.JSX.Element | null {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const text = word.scripts?.[script] ?? word.t;
  const lowConfidence = word.c !== undefined && word.c < confidenceThreshold;

  useEffect(() => {
    if (editing && ref.current !== null) {
      ref.current.textContent = text;
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      const selectionApi = window.getSelection();
      selectionApi?.removeAllRanges();
      selectionApi?.addRange(range);
    }
    // Only when entering edit mode; re-running on every `text` change would
    // fight the caret while the user is still typing.
  }, [editing]);

  if (word.filler === true && hideFillers) return null;

  function commit(): void {
    const value = ref.current?.textContent ?? text;
    setEditing(false);
    if (value.trim() !== text) onCommit(word.wid, value.trim());
  }

  function cancel(): void {
    setEditing(false);
  }

  return (
    <span
      ref={ref}
      role="textbox"
      aria-label={`Word "${text}"`}
      contentEditable={editing}
      suppressContentEditableWarning
      tabIndex={0}
      data-testid={`word-chip-${word.wid}`}
      data-word-id={word.wid}
      data-filler={word.filler === true ? "true" : undefined}
      data-active={active ? "true" : undefined}
      className={cn(
        "inline-block cursor-text rounded px-0.5 py-px outline-none",
        "focus-visible:ring-2 focus-visible:ring-lime-400",
        active && "bg-lime-400/30",
        selected && !active && "bg-sky-400/20",
        word.filler === true && "text-fg-3 opacity-50",
        lowConfidence && "underline decoration-amber-400 decoration-2 underline-offset-2",
      )}
      onDoubleClick={(event) => {
        if (editing) return;
        event.preventDefault();
        onFixSpellingEverywhere?.(word.wid, text);
      }}
      onClick={(event) => {
        if (editing) return;
        onSelect?.(word.wid);
        if (!event.shiftKey) onSeek?.(word.s);
      }}
      onBlur={() => {
        if (editing) commit();
      }}
      onKeyDown={(event) => {
        if (editing) {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      {editing ? null : text}
    </span>
  );
}
