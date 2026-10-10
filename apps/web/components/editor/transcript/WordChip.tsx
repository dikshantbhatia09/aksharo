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
import { InlineEmojiPicker } from "./InlineEmojiPicker";
import { InlineWordColorPicker } from "./InlineWordColorPicker";

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
  readonly emphasized?: boolean;
  /** Fillers hidden entirely rather than dimmed, per the toggle. */
  readonly hideFillers?: boolean;
  /** Below this the word is underlined amber (low ASR confidence). */
  readonly confidenceThreshold?: number;
  readonly onCommit: (wordId: string, text: string) => void;
  readonly onSeek?: (ms: number) => void;
  readonly onSelect?: (wordId: string) => void;
  /** Double-click: "Fix spelling everywhere". */
  readonly onFixSpellingEverywhere?: (wordId: string, text: string) => void;
  /** One-click emoji customization: swap or delete emoji. */
  readonly onEmojiChange?: (wordId: string, emoji: string | null) => void;
  /** One-click dynamic keyword highlight color customization. */
  readonly onColorChange?: (wordId: string, color: string | null) => void;
  readonly paletteAccents?: readonly string[];
  /** Move to next word (Tab shortcut). */
  readonly onNavigateNext?: (wordId: string) => void;
  /** Move to previous word (Shift+Tab shortcut). */
  readonly onNavigatePrev?: (wordId: string) => void;
  /** Split line at this word (Enter / Shift+Enter shortcut). */
  readonly onSplitLine?: (wordId: string) => void;
  /** Merge line with previous (Backspace on first word). */
  readonly onMergeWithPrev?: (wordId: string) => void;
  /** Whether this word is the first word in its line. */
  readonly isFirstInLine?: boolean;
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
  emphasized = word.isEmphasized === true,
  hideFillers = false,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  onCommit,
  onSeek,
  onSelect,
  onFixSpellingEverywhere,
  onEmojiChange,
  onColorChange,
  paletteAccents,
  onNavigateNext,
  onNavigatePrev,
  onSplitLine,
  onMergeWithPrev,
  isFirstInLine,
}: WordChipProps): React.JSX.Element | null {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawWord = word as any;
  const accentColor: string | undefined = rawWord.accentColor ?? rawWord.customColorHex;
  const wordEmoji = rawWord.emoji;
  const emojiChar = typeof wordEmoji === "string" ? wordEmoji : wordEmoji?.char;
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
    <span className="relative inline-flex items-center group/chip">
      {emojiChar && (
        <button
          type="button"
          data-testid={`word-emoji-trigger-${word.wid}`}
          aria-label={`Emoji ${emojiChar}, click to change`}
          className="inline-flex items-center justify-center mr-0.5 text-xs hover:scale-125 transition-transform cursor-pointer select-none"
          onClick={(event) => {
            event.stopPropagation();
            setPickerOpen((prev) => !prev);
          }}
        >
          {emojiChar}
        </button>
      )}
      {pickerOpen && (
        <InlineEmojiPicker
          currentEmoji={emojiChar}
          onSelect={(em) => onEmojiChange?.(word.wid, em)}
          onRemove={() => onEmojiChange?.(word.wid, null)}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {colorPickerOpen && (
        <InlineWordColorPicker
          currentColor={accentColor}
          paletteAccents={paletteAccents}
          onSelectColor={(col) => onColorChange?.(word.wid, col)}
          onClose={() => setColorPickerOpen(false)}
        />
      )}
      {(accentColor !== undefined || onColorChange !== undefined) && (
        <button
          type="button"
          data-testid={`word-color-trigger-${word.wid}`}
          aria-label={accentColor ? `Highlight color ${accentColor}, click to change` : "Add highlight color"}
          className={cn(
            "inline-flex items-center justify-center mr-0.5 size-2 rounded-full cursor-pointer select-none transition-all hover:scale-150",
            accentColor ? "opacity-100 ring-1 ring-white/50" : "opacity-0 group-hover/chip:opacity-60",
          )}
          style={{ backgroundColor: accentColor ?? "#FFF000" }}
          onClick={(event) => {
            event.stopPropagation();
            setColorPickerOpen((prev) => !prev);
          }}
        />
      )}
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
        style={accentColor ? { color: accentColor } : undefined}
        className={cn(
          "editor-word-chip text-fg-0 inline-block cursor-text rounded-[6px] px-0.5 py-0.5 text-[15px] outline-none transition-colors duration-[160ms]",
          "hover:bg-bg-2 hover:text-fg-0",
          "focus-visible:ring-2 focus-visible:ring-accent",
          active &&
            "bg-accent-900 text-accent-200 hover:bg-accent-900 hover:text-accent-200 ring-1 ring-accent",
          selected && !active && "ring-1 ring-accent",
          emphasized && "editor-word-emphasis",
          // Fillers are content, not disabled controls: fg-2 (6.1:1) plus italics,
          // so they read as quieter without falling under 4.5:1.
          word.filler === true && "text-fg-2 italic",
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
            if (event.key === "Tab") {
              event.preventDefault();
              commit();
              if (event.shiftKey) {
                onNavigatePrev?.(word.wid);
              } else {
                onNavigateNext?.(word.wid);
              }
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              if (event.shiftKey && onSplitLine) {
                onSplitLine(word.wid);
              }
              return;
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
              return;
            } else if (
              event.key === "Backspace" &&
              (ref.current?.textContent ?? "").trim() === "" &&
              isFirstInLine &&
              onMergeWithPrev
            ) {
              event.preventDefault();
              cancel();
              onMergeWithPrev(word.wid);
              return;
            }
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            if (event.shiftKey) {
              onNavigatePrev?.(word.wid);
            } else {
              onNavigateNext?.(word.wid);
            }
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey && onSplitLine) {
              onSplitLine(word.wid);
            } else {
              setEditing(true);
            }
            return;
          }
          if (event.key === "Backspace" && isFirstInLine && onMergeWithPrev) {
            event.preventDefault();
            onMergeWithPrev(word.wid);
            return;
          }
        }}
      >
        {editing ? null : text}
      </span>
    </span>
  );
}

WordChipImpl.displayName = "WordChipImpl";
