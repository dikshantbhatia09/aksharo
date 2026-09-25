"use client";

import * as React from "react";

import { scriptForLanguage } from "../fonts/indic";
import { cn } from "../lib/cn";
import { Badge } from "../primitives/surface";

import type { BadgeProps } from "../primitives/surface";

/**
 * The keyboard hint that follows a label in menus and tooltips.
 *
 * Keys are rendered in the mono face and the modifier is written the way the
 * user's platform writes it, because "Ctrl+K" on a Mac is wrong and a Mac user
 * reads it as a bug.
 */
export function ShortcutHint({
  keys,
  className,
}: {
  keys: readonly string[];
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("ml-auto flex items-center gap-1", className)} aria-hidden="true">
      {keys.map((key) => (
        <kbd
          key={key}
          className="border-border bg-bg-2 text-fg-2 rounded-sm border px-1.5 py-0.5 font-mono text-2xs"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** True when the browser is running on a Mac, so `Ctrl` becomes `⌘`. */
export function isAppleShortcutPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  return /mac|iphone|ipad|ipod/i.test(value);
}

/** `["Ctrl", "K"]` → `["⌘", "K"]` on Apple platforms. */
export function shortcutKeys(keys: readonly string[], apple?: boolean): string[] {
  const isApple = apple ?? isAppleShortcutPlatform();
  return keys.map((key) => {
    if (!isApple) return key;
    if (key === "Ctrl") return "⌘";
    if (key === "Alt") return "⌥";
    if (key === "Shift") return "⇧";
    return key;
  });
}

/** Project status, straight from the API's `projects.status`. */
export type ProjectStatus = "draft" | "processing" | "ready" | "failed" | "archived" | "queued";

const STATUS_TONE: Record<ProjectStatus, NonNullable<BadgeProps["tone"]>> = {
  draft: "neutral",
  queued: "info",
  processing: "proposed",
  ready: "accepted",
  failed: "rejected",
  archived: "neutral",
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  processing: "Working",
  ready: "Ready",
  failed: "Failed",
  archived: "Archived",
};

export function StatusChip({
  status,
  className,
}: {
  status: ProjectStatus;
  className?: string;
}): React.JSX.Element {
  return (
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    <Badge tone={STATUS_TONE[status]} className={className} data-testid="status-chip">
      {/* eslint-disable-next-line security/detect-object-injection -- bracket access on `status`, a typed enum value, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion */}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Display names for the language tags the pipeline routes on. */
export const LANGUAGE_LABEL: Record<string, string> = {
  "hi-Latn": "Hinglish",
  hi: "हिन्दी",
  en: "English",
  "en-IN": "English (IN)",
  bn: "বাংলা",
  ta: "தமிழ்",
  te: "తెలుగు",
  kn: "ಕನ್ನಡ",
  ml: "മലയാളം",
  mr: "मराठी",
  gu: "ગુજરાતી",
  pa: "ਪੰਜਾਬੀ",
  or: "ଓଡ଼ିଆ",
  as: "অসমীয়া",
  ur: "اردو",
};

/**
 * The language a project was transcribed in. Native names are rendered in the
 * matching Noto face; the shell asks for that face on demand (08 §1), so the
 * chip only declares `lang` and the font stack.
 */
export function LangChip({
  language,
  className,
}: {
  language: string;
  className?: string;
}): React.JSX.Element {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const label = LANGUAGE_LABEL[language] ?? language;
  const script = scriptForLanguage(language);
  return (
    <Badge
      tone="neutral"
      lang={language}
      className={cn("font-normal", className)}
      data-testid="lang-chip"
      data-script={script ?? "latin"}
    >
      {label}
    </Badge>
  );
}
