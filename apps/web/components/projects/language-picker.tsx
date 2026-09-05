"use client";

/**
 * The spoken-language picker (FIX-04).
 *
 * One component, two writers: the Home quick-pick row (before anything is
 * uploaded) and the editor's waiting screen (after a project got stuck without
 * a language). Both need the identical contract — `value` may be `undefined`,
 * and `undefined` renders as *nothing selected* rather than as a guess.
 *
 * That "nothing selected" is the whole point. Home used to stamp every project
 * `hi-Latn` because the onboarding step that asks is skipped by dev
 * auto-verification, so the router sent Hinglish down the pure-Hindi lane and
 * the credits were spent on an answer the user never gave. A language is a
 * cost decision; it comes from a gesture or it does not come at all.
 *
 * The three most-picked tags are segmented buttons so the common case is one
 * click; everything else lives under "More…", whose list is the onboarding
 * step's own (`app/(app)/onboarding/onboarding-flow.tsx`'s `LANGUAGES`) so the
 * two screens can never disagree about what this product captions.
 */
import * as React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@montaj/ui";

import { cn } from "@/lib/utils";

/**
 * Every language offered, in the onboarding step's order — the same list
 * `onboarding-flow.tsx` shows, deliberately duplicated nowhere else.
 */
export const QUICK_PICK_LANGUAGES = [
  { key: "hi-Latn", label: "Hinglish (Roman)" },
  { key: "hi", label: "हिन्दी" },
  { key: "en-IN", label: "English (India)" },
  { key: "en", label: "English" },
  { key: "bn", label: "বাংলা" },
  { key: "ta", label: "தமிழ்" },
  { key: "te", label: "తెలుగు" },
  { key: "mr", label: "मराठी" },
  { key: "kn", label: "ಕನ್ನಡ" },
  { key: "ml", label: "മലയാളം" },
  { key: "gu", label: "ગુજરાતી" },
  { key: "pa", label: "ਪੰਜਾਬੀ" },
] as const;

/** The three that earn a one-click button; the rest live under "More…". */
const SEGMENTED: readonly { readonly key: string; readonly label: string }[] = [
  { key: "hi", label: "Hindi" },
  { key: "hi-Latn", label: "Hinglish" },
  { key: "en", label: "English" },
];

const SEGMENTED_KEYS: ReadonlySet<string> = new Set(SEGMENTED.map((entry) => entry.key));

/** The browser-local memory of the last explicit pick (FIX-04 step 1a). */
export const LANGUAGE_MEMORY_KEY = "montaj.quickpick.language";

/** The display name for a tag, falling back to the tag itself. */
export function languageLabel(tag: string): string {
  return QUICK_PICK_LANGUAGES.find((entry) => entry.key === tag)?.label ?? tag;
}

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
}

export function LanguagePicker({
  value,
  onChange,
  className,
}: LanguagePickerProps): React.JSX.Element {
  const inMore = value !== undefined && !SEGMENTED_KEYS.has(value);
  const moreLabel = inMore ? languageLabel(value) : "More…";

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      role="group"
      aria-label="Spoken language"
      data-testid="quickpick-language"
      data-language={value ?? ""}
      tabIndex={-1}
    >
      <span className="text-fg-2 mr-1 text-xs">Spoken language</span>
      {SEGMENTED.map((entry) => (
        <button
          key={entry.key}
          type="button"
          aria-pressed={value === entry.key}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm",
            value === entry.key
              ? "border-lime-500 bg-lime-500/10 text-fg-0"
              : "border-border bg-bg-2 text-fg-1 hover:text-fg-0",
          )}
          data-testid={`quick-pick-language-${entry.key}`}
          onClick={() => onChange(entry.key)}
        >
          {entry.label}
        </button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-pressed={inMore}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              inMore
                ? "border-lime-500 bg-lime-500/10 text-fg-0"
                : "border-border bg-bg-2 text-fg-1 hover:text-fg-0",
            )}
            data-testid="quick-pick-language-more"
          >
            {moreLabel}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {QUICK_PICK_LANGUAGES.filter((entry) => !SEGMENTED_KEYS.has(entry.key)).map((entry) => (
            <DropdownMenuItem
              key={entry.key}
              onSelect={() => onChange(entry.key)}
              data-testid={`quick-pick-language-${entry.key}`}
            >
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
