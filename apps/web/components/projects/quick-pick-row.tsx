"use client";

/**
 * The Home drop zone's quick-pick row (08 §Home: "Hinglish (Roman) · Punch Pop
 * · 9:16") — language, style and aspect, chosen once and carried into every
 * file the drop zone below it uploads. The default language is read from the
 * signed-in user's own languages (F-002 onboarding, `onboarding.languages[0]`)
 * and falls back to Hinglish (Roman), which every plan and every audience this
 * product targets can caption.
 */
import * as React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@montaj/ui";

import { StyleQuickPick } from "./style-quick-pick";

import type { UploadQuickPick } from "@/lib/upload/types";

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

export const QUICK_PICK_ASPECTS = [
  { key: "9:16", label: "9:16 · Reels & Shorts" },
  { key: "16:9", label: "16:9 · YouTube" },
  { key: "1:1", label: "1:1 · Square" },
  { key: "4:5", label: "4:5 · Feed" },
] as const;

/** The recommended default: the caller's first onboarding language, or Hinglish. */
export function defaultQuickPickLanguage(
  onboardingLanguages: readonly string[] | undefined,
): string {
  const first = onboardingLanguages?.[0];
  return first !== undefined && QUICK_PICK_LANGUAGES.some((entry) => entry.key === first)
    ? first
    : "hi-Latn";
}

export function QuickPickRow({
  value,
  onChange,
}: {
  value: UploadQuickPick;
  onChange: (value: UploadQuickPick) => void;
}): React.JSX.Element {
  const languageLabel =
    QUICK_PICK_LANGUAGES.find((entry) => entry.key === value.language)?.label ?? value.language;
  const aspectLabel =
    QUICK_PICK_ASPECTS.find((entry) => entry.key === value.aspect)?.label ?? value.aspect;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Language, style and aspect for what you upload next"
      data-testid="quick-pick-row"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="border-border bg-bg-2 text-fg-1 hover:text-fg-0 rounded-full border px-3 py-1.5 text-sm"
            data-testid="quick-pick-language"
          >
            {languageLabel}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {QUICK_PICK_LANGUAGES.map((entry) => (
            <DropdownMenuItem
              key={entry.key}
              onSelect={() => {
                onChange({ ...value, language: entry.key });
              }}
              data-testid={`quick-pick-language-${entry.key}`}
            >
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="text-fg-2" aria-hidden="true">
        ·
      </span>

      <StyleQuickPick
        styleId={value.styleId}
        onChange={(styleId) => {
          onChange({ ...value, styleId });
        }}
      />

      <span className="text-fg-2" aria-hidden="true">
        ·
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="border-border bg-bg-2 text-fg-1 hover:text-fg-0 rounded-full border px-3 py-1.5 text-sm"
            data-testid="quick-pick-aspect"
          >
            {value.aspect}
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
      <span className="sr-only">{aspectLabel}</span>
    </div>
  );
}
