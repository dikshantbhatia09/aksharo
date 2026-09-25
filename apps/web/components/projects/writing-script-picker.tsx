"use client";

/**
 * The writing-script picker (K02 scope item 2, reference frame
 * `frame_0020.png`'s "Writing system used?" field).
 *
 * **What this does and does not do.** The transcribe request contract
 * (`TranscribeRequestDto`, `apps/api/src/transcripts/transcripts.dto.ts:41-52`)
 * accepts `languages`, `hints`, `diarise` and `captions` — there is no
 * upload-time "script" parameter, and K02's brief is explicit that none
 * should be added. `script` only exists post-transcription, as the query
 * param the transcript/export routes accept (`roman | native | en |
 * translated`, `transcripts.dto.ts:69`) and as the editor's own
 * `ScriptTabs` strip (`components/editor/transcript/scripts/ScriptTabs.tsx`).
 * So this picker's job is narrower than the spoken-language one: it records
 * which of those tabs a person means to read captions in, for the *editor* to
 * pick up as its starting tab — not a value the upload or transcribe request
 * ever carries. See `prepare-media-modal.tsx`'s file doc and this WP's
 * `REPORT.md` for exactly how far that wiring reaches today.
 *
 * Three options only — `roman`/`native`/`en`, the same keys `ScriptTabs`'
 * `SCRIPT_LABELS` uses — so a `DropdownMenuRadioGroup` fits better than the
 * search+group combobox the (15-language) spoken-language picker needs.
 */
import { ChevronDown, Type } from "lucide-react";
import * as React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@montaj/ui";

import { cn } from "@/lib/utils";

export interface WritingScriptOption {
  readonly key: "roman" | "native" | "en";
  readonly label: string;
  readonly hint: string;
}

/** Matches `ScriptTabs`' `SCRIPT_LABELS` (`roman`/`native`/`en`) exactly. */
export const WRITING_SCRIPTS: readonly WritingScriptOption[] = [
  { key: "roman", label: "Roman", hint: "Latin-script transliteration (e.g. Hinglish)" },
  { key: "native", label: "Native", hint: "The language's own script" },
  { key: "en", label: "English", hint: "English captions, once translated" },
];

/** The browser-local memory of the last explicit pick, mirroring `LANGUAGE_MEMORY_KEY`. */
export const WRITING_SCRIPT_MEMORY_KEY = "montaj.quickpick.writingScript";

/** The display label for a script key, falling back to the key itself. */
export function writingScriptLabel(key: string): string {
  return WRITING_SCRIPTS.find((entry) => entry.key === key)?.label ?? key;
}

/** Same "throws in some real configurations" tolerance as `rememberedLanguage`. */
export function rememberedWritingScript(): string | undefined {
  try {
    return localStorage.getItem(WRITING_SCRIPT_MEMORY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberWritingScript(key: string): void {
  try {
    localStorage.setItem(WRITING_SCRIPT_MEMORY_KEY, key);
  } catch {
    /* storage unavailable — the pick still stands for this session */
  }
}

export interface WritingScriptPickerProps {
  /** `undefined` means nothing is selected yet, and renders that way. */
  readonly value: string | undefined;
  readonly onChange: (key: string) => void;
  readonly className?: string;
  readonly placeholder?: string;
  /** A full-width field (the "Prepare Your Media" modal) instead of the compact pill. */
  readonly fullWidth?: boolean;
}

export function WritingScriptPicker({
  value,
  onChange,
  className,
  placeholder = "Choose writing script",
  fullWidth = false,
}: WritingScriptPickerProps): React.JSX.Element {
  const currentLabel = value === undefined ? placeholder : writingScriptLabel(value);

  return (
    <div
      className={cn(fullWidth ? "block w-full" : "inline-block", className)}
      data-testid="quickpick-writing-script"
      data-script={value ?? ""}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Writing script"
            className={cn(
              // Same shape as the spoken-language chip beside it in the modal.
              "flex min-h-8 items-center gap-2 rounded-sm border px-2.5 py-1.5 text-xs",
              "hover:bg-neutral-100/7 transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
              fullWidth && "bg-sunken h-9 w-full justify-between text-sm",
              value !== undefined
                ? "border-border text-fg-0"
                : "border-neutral-600 border-dashed text-fg-1",
            )}
            data-testid="quick-pick-writing-script-trigger"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Type className="text-fg-2 size-3.5 shrink-0" aria-hidden="true" />
              <span className={cn("truncate", fullWidth ? "max-w-none" : "max-w-40")}>
                {currentLabel}
              </span>
            </span>
            <ChevronDown className="text-fg-2 size-3.5 shrink-0" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className={cn(fullWidth && "w-[--radix-dropdown-menu-trigger-width]")}
        >
          <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
            {WRITING_SCRIPTS.map((entry) => (
              <DropdownMenuRadioItem
                key={entry.key}
                value={entry.key}
                data-testid={`quick-pick-writing-script-${entry.key}`}
              >
                <span className="flex flex-col">
                  <span>{entry.label}</span>
                  <span className="text-fg-2 text-xs">{entry.hint}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
