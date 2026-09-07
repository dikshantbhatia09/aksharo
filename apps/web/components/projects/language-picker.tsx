"use client";

/**
 * The spoken-language picker (FIX-04, upgraded to a searchable combobox by K02).
 *
 * One component, several writers: the Home quick-pick row, the editor's
 * waiting screen (a project stuck without a language), and the "Prepare Your
 * Media" modal's language field. All three need the identical contract —
 * `value` may be `undefined`, and `undefined` renders as *nothing selected*
 * rather than as a guess.
 *
 * That "nothing selected" is the whole point. Home used to stamp every project
 * `hi-Latn` because the onboarding step that asks is skipped by dev
 * auto-verification, so the router sent Hinglish down the pure-Hindi lane and
 * the credits were spent on an answer the user never gave. A language is a
 * cost decision; it comes from a gesture or it does not come at all.
 *
 * K02 replaced the old flat "3 buttons + More…" dropdown with a single
 * trigger that opens a searchable, grouped list (reference frames
 * `frame_0020.png`/`frame_0040.png`: "Desi & Regional" first, everything else
 * alphabetically after it) — built from `@montaj/ui`'s `Command` primitive
 * (`cmdk`), which already does fuzzy search and group filtering, composed
 * here into a small local popover rather than a full command-palette dialog.
 * The full language list now lives in `./languages.ts`, the one place both
 * this component and `onboarding-flow.tsx` read it from.
 */
import { Check, ChevronDown, Languages as LanguagesIcon } from "lucide-react";
import * as React from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@montaj/ui";

import { ALL_LANGUAGES, DESI_LANGUAGES, languageLabel, OTHER_LANGUAGES } from "./languages";

import { cn } from "@/lib/utils";

export { ALL_LANGUAGES, languageLabel };

/**
 * Kept for existing importers (`quick-pick-row.tsx` re-exports it): the full,
 * deduplicated language list. Every language this product offers lives in
 * `./languages.ts` now — this name just points at it.
 */
export const QUICK_PICK_LANGUAGES: readonly { readonly key: string; readonly label: string }[] =
  ALL_LANGUAGES;

/** The browser-local memory of the last explicit pick (FIX-04 step 1a). */
export const LANGUAGE_MEMORY_KEY = "montaj.quickpick.language";

/**
 * The last language this browser explicitly chose, or `undefined`.
 *
 * `localStorage` throws outright in a few real configurations (Safari private
 * mode, third-party-cookie blocking in an iframe), and "no memory" is the
 * correct answer for all of them — an empty pick is never wrong, it just asks.
 */
export function rememberedLanguage(): string | undefined {
  try {
    return localStorage.getItem(LANGUAGE_MEMORY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort: remembering a pick must never break making one. */
export function rememberLanguage(tag: string): void {
  try {
    localStorage.setItem(LANGUAGE_MEMORY_KEY, tag);
  } catch {
    /* storage unavailable — the pick still stands for this session */
  }
}

export interface LanguagePickerProps {
  /** `undefined` means nothing is selected yet, and renders that way. */
  readonly value: string | undefined;
  readonly onChange: (tag: string) => void;
  readonly className?: string;
  /** Overrides the trigger's placeholder text when nothing is chosen. */
  readonly placeholder?: string;
  /** A full-width field (the "Prepare Your Media" modal) instead of the compact pill (the quick-pick row). */
  readonly fullWidth?: boolean;
}

function optionSearchValue(entry: (typeof ALL_LANGUAGES)[number]): string {
  return `${entry.label} ${entry.english} ${entry.key}`;
}

export function LanguagePicker({
  value,
  onChange,
  className,
  placeholder = "Choose spoken language",
  fullWidth = false,
}: LanguagePickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const select = (tag: string): void => {
    onChange(tag);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const currentLabel = value === undefined ? placeholder : languageLabel(value);

  return (
    <div
      ref={containerRef}
      className={cn("relative", fullWidth ? "block w-full" : "inline-block", className)}
      data-testid="quickpick-language"
      data-language={value ?? ""}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Spoken language"
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm",
          fullWidth && "w-full justify-between rounded-md",
          value !== undefined
            ? "border-lime-500 bg-lime-500/10 text-fg-0"
            : "border-border bg-bg-2 text-fg-1 hover:text-fg-0",
        )}
        data-testid="quick-pick-language-trigger"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <LanguagesIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className={cn("truncate", fullWidth ? "max-w-none" : "max-w-40")}>
            {currentLabel}
          </span>
        </span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={cn(
            "border-border bg-bg-1 absolute top-full left-0 z-50 mt-1 overflow-hidden rounded-md border shadow-[var(--shadow-panel)]",
            fullWidth ? "w-full min-w-64" : "w-64",
          )}
          data-testid="quick-pick-language-popover"
        >
          <Command loop>
            <CommandInput
              autoFocus
              placeholder="Search languages…"
              data-testid="quick-pick-language-search"
              aria-label="Search languages"
            />
            <CommandList>
              <CommandEmpty>No language found.</CommandEmpty>
              <CommandGroup heading="Desi & Regional">
                {DESI_LANGUAGES.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={optionSearchValue(entry)}
                    onSelect={() => {
                      select(entry.key);
                    }}
                    data-testid={`quick-pick-language-${entry.key}`}
                    role="option"
                    aria-selected={value === entry.key}
                  >
                    <Check
                      className={cn("text-lime-500 size-4", value !== entry.key && "invisible")}
                      aria-hidden="true"
                    />
                    {entry.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="More languages">
                {OTHER_LANGUAGES.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={optionSearchValue(entry)}
                    onSelect={() => {
                      select(entry.key);
                    }}
                    data-testid={`quick-pick-language-${entry.key}`}
                    role="option"
                    aria-selected={value === entry.key}
                  >
                    <Check
                      className={cn("text-lime-500 size-4", value !== entry.key && "invisible")}
                      aria-hidden="true"
                    />
                    {entry.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      ) : null}
    </div>
  );
}
