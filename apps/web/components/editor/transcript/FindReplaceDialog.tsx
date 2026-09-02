"use client";

/**
 * Ctrl+F: find & replace across the transcript's live words. Regex is off by
 * default (brief §3); "Replace all" emits one `EditWord` per match, batched as
 * a single undo step by the caller.
 */
import { useMemo, useState } from "react";

import type { Word } from "@montaj/edg";

import { findMatches, replaceAll, type WordMatch } from "@/lib/edg/find-replace";
import { cn } from "@/lib/utils";

export interface FindReplaceDialogProps {
  readonly open: boolean;
  readonly words: readonly Word[];
  readonly script: "roman" | "native" | "en";
  readonly onClose: () => void;
  readonly onReplaceAll: (matches: readonly WordMatch[]) => void;
}

export function FindReplaceDialog({
  open,
  words,
  script,
  onClose,
  onReplaceAll,
}: FindReplaceDialogProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);

  const matches = useMemo(
    () => findMatches(words, query, script, { regex, caseSensitive }),
    [words, query, script, regex, caseSensitive],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Find and replace"
      data-testid="find-replace-dialog"
      className="border-white/10 bg-bg-1 fixed top-16 right-4 z-30 flex w-80 flex-col gap-2 rounded-lg border p-3 shadow-xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Find &amp; replace</span>
        <button
          type="button"
          data-testid="find-replace-close"
          aria-label="Close"
          className="text-fg-3 hover:text-fg-0"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <input
        type="text"
        autoFocus
        placeholder="Find"
        value={query}
        aria-label="Find"
        data-testid="find-replace-query"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
      />
      <input
        type="text"
        placeholder="Replace with"
        value={replacement}
        aria-label="Replace with"
        data-testid="find-replace-replacement"
        onChange={(event) => {
          setReplacement(event.target.value);
        }}
        className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
      />

      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={regex}
            data-testid="find-replace-regex"
            onChange={(event) => {
              setRegex(event.target.checked);
            }}
          />
          Regex
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={caseSensitive}
            data-testid="find-replace-case-sensitive"
            onChange={(event) => {
              setCaseSensitive(event.target.checked);
            }}
          />
          Case sensitive
        </label>
      </div>

      <div className="text-fg-3 text-xs" data-testid="find-replace-count">
        {matches.length} match{matches.length === 1 ? "" : "es"}
      </div>

      <button
        type="button"
        data-testid="find-replace-apply"
        disabled={matches.length === 0}
        className={cn(
          "rounded-md bg-lime-400 px-3 py-1.5 text-sm font-medium text-black",
          matches.length === 0 && "cursor-not-allowed opacity-40",
        )}
        onClick={() => {
          if (matches.length === 0) return;
          onReplaceAll(replaceAll(matches, replacement));
          onClose();
        }}
      >
        Replace all
      </button>
    </div>
  );
}
