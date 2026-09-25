"use client";

/**
 * The Home drop zone's quick-pick row (08 §Home: "Hinglish (Roman) · Punch Pop
 * · 9:16") — language, style and aspect, chosen once and carried into every
 * file the drop zone below it uploads.
 *
 * FIX-04: the language half moved into the shared {@link LanguagePicker} (the
 * waiting screen mounts the same control) and it no longer falls back to
 * Hinglish. There is no such thing as a safe default here: the tag routes the
 * transcription lane and the credits are spent on whatever it says, so an
 * unanswered question stays visibly unanswered.
 */
import { ChevronDown } from "lucide-react";
import * as React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@montaj/ui";

import { LanguagePicker, QUICK_PICK_LANGUAGES } from "./language-picker";
import { StyleQuickPick } from "./style-quick-pick";

import type { UploadQuickPick } from "@/lib/upload/types";

/** Re-exported so existing importers of the row keep resolving the same list. */
export { QUICK_PICK_LANGUAGES };

export const QUICK_PICK_ASPECTS = [
  { key: "9:16", label: "9:16 · Reels & Shorts" },
  { key: "16:9", label: "16:9 · YouTube" },
  { key: "1:1", label: "1:1 · Square" },
  { key: "4:5", label: "4:5 · Feed" },
] as const;

/**
 * The caller's own onboarding answer, when they gave one we offer.
 *
 * FIX-04 removed this function's fallback. It used to return Hinglish for a
 * user who had never reached the onboarding step — which is every user whose
 * email was auto-verified — and that guess is what the audit found stamped on
 * every project. `undefined` now means "nobody has said", which is the truth
 * and which the picker renders as nothing selected.
 */
export function defaultQuickPickLanguage(
  onboardingLanguages: readonly string[] | undefined,
): string | undefined {
  const first = onboardingLanguages?.[0];
  return first !== undefined && QUICK_PICK_LANGUAGES.some((entry) => entry.key === first)
    ? first
    : undefined;
}

export function QuickPickRow({
  value,
  onChange,
}: {
  value: UploadQuickPick;
  onChange: (value: UploadQuickPick) => void;
}): React.JSX.Element {
  const aspectLabel =
    QUICK_PICK_ASPECTS.find((entry) => entry.key === value.aspect)?.label ?? value.aspect;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Language, style and aspect for what you upload next"
      data-testid="quick-pick-row"
    >
      <LanguagePicker
        kicker="Spoken"
        value={value.language}
        onChange={(language) => {
          onChange({ ...value, language });
        }}
      />

      <StyleQuickPick
        styleId={value.styleId}
        onChange={(styleId) => {
          onChange({ ...value, styleId });
        }}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="border-border text-fg-0 flex min-h-8 items-center gap-2 rounded-sm border px-2.5 py-1.5 text-xs transition-colors duration-[160ms] ease-[var(--ease-out-soft)] hover:bg-neutral-100/7"
            aria-label={`Frame: ${aspectLabel}`}
            data-testid="quick-pick-aspect"
          >
            <span className="text-fg-2 text-2xs font-medium tracking-[0.06em] uppercase" aria-hidden="true">
              Frame
            </span>
            {value.aspect}
            <ChevronDown className="text-fg-2 size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {QUICK_PICK_ASPECTS.map((entry) => (
            <DropdownMenuItem
              key={entry.key}
              onSelect={() => {
                onChange({ ...value, aspect: entry.key });
              }}
              data-testid={`quick-pick-aspect-${entry.key}`}
            >
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
