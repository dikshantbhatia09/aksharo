"use client";

/**
 * Ctrl+F: find & replace across the transcript's live words. Regex is off by
 * default (brief §3); "Replace all" emits one `EditWord` per match, batched as
 * a single undo step by the caller.
 */
import { X } from "lucide-react";
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
      className="border-border bg-bg-1 fixed top-16 right-4 z-30 flex w-80 flex-col gap-2 rounded-md border p-3 shadow-xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-fg-2 text-2xs font-medium tracking-wide uppercase">
          Find &amp; replace
        </span>
        <button
          type="button"
          data-testid="find-replace-close"
          aria-label="Close"
          className="text-fg-2 hover:text-fg-0 flex size-7 items-center justify-center rounded-sm transition-colors duration-[160ms]"
          onClick={onClose}
        >
          <X className="size-3.5" aria-hidden="true" />
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
        className="border-border bg-bg-0 text-fg-0 placeholder:text-fg-2 h-8 w-full rounded-sm border px-2.5 text-xs"
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
        className="border-border bg-bg-0 text-fg-0 placeholder:text-fg-2 h-8 w-full rounded-sm border px-2.5 text-xs"
      />

      <div className="flex flex-col">
        <label className="text-fg-1 flex min-h-8 items-center justify-between gap-3 text-sm">
          Regex
          <input
            type="checkbox"
            checked={regex}
            data-testid="find-replace-regex"
            onChange={(event) => {
              setRegex(event.target.checked);
            }}
            className="panel-switch"
          />
        </label>
        <label className="text-fg-1 flex min-h-8 items-center justify-between gap-3 text-sm">
          Case sensitive
          <input
            type="checkbox"
            checked={caseSensitive}
            data-testid="find-replace-case-sensitive"
            onChange={(event) => {
              setCaseSensitive(event.target.checked);
            }}
            className="panel-switch"
          />
        </label>
      </div>

      <div className="text-fg-2 text-2xs tabular-nums" data-testid="find-replace-count">
        {matches.length} match{matches.length === 1 ? "" : "es"}
      </div>

      <button
        type="button"
        data-testid="find-replace-apply"
        disabled={matches.length === 0}
        className={cn(
          "bg-lime-500 hover:bg-lime-600 text-on-accent flex h-8 items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors duration-[160ms]",
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
