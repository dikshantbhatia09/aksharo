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
import { memo, useEffect, useRef, useState } from "react";

import type { Word } from "@montaj/edg";

import { cn } from "@/lib/utils";

export type DisplayScript = "roman" | "native" | "en";

/** Narrows a script tab value (A22's `ScriptTabs` also offers `"translated"`) to a per-word display script. */
export function isWordDisplayScript(script: string): script is DisplayScript {
  return script === "roman" || script === "native" || script === "en";
}

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

/**
 * Memoised: the adversarial perf test's window is mostly new words every
 * frame, but a "natural" wheel scroll and the overscan margin both revisit
 * words whose props have not changed — this skips reconciling the
 * `contentEditable` span (and its several event handlers) for those. Depends
 * on `SegmentCard` handing every word a stable `word` reference (the parent
 * `TranscriptList`'s `getWords` cache) and a stable `onSelect` (its
 * `handleWordSelect`, `useCallback`-memoised per segment).
 */
export const WordChip = memo(WordChipImpl);

function WordChipImpl({
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
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
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
        "bg-bg-2 text-fg-1 inline-block cursor-text rounded-[6px] px-1.5 py-0.5 text-xs outline-none transition-colors duration-[160ms]",
        "hover:bg-bg-2 hover:text-fg-0",
        "focus-visible:ring-2 focus-visible:ring-lime-500",
        active && "bg-lime-500/12 text-lime-500 hover:bg-lime-500/12 hover:text-lime-500",
        selected && !active && "ring-1 ring-lime-500",
        word.filler === true && "text-fg-disabled",
        lowConfidence &&
          "text-proposed underline decoration-proposed decoration-dotted underline-offset-2",
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

WordChipImpl.displayName = "WordChipImpl";
