"use client";

/**
 * The hook title's control (2026-09-29): its words, and a way to take it off.
 *
 * An Autopilot clip starts with a hook title — a card over its first seconds
 * (`EdgHot.overlays`, kind `hook-title`), drawn by render-core on the stage and
 * in every export. This is where a person rewords it or removes it. Nothing
 * here places it: where it sits is render-core's call, off the faces and the
 * captions, so there is no position to get wrong.
 *
 * One op per committed edit (leaving the field, or Enter), never one per
 * keystroke. Removing is not confirmed: it is one undo away, like any edit.
 */

import { useEffect, useId, useState } from "react";

import { Button, Input } from "@montaj/ui";

/** The same bound the document holds the words to (`@montaj/edg` `OVERLAY_TEXT_MAX`). */
export const HOOK_TITLE_MAX_CHARS = 120;

export interface HookTitleOverlay {
  readonly id: string;
  readonly kind: "hook-title";
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface HookTitleFieldProps {
  readonly overlay: HookTitleOverlay;
  /** The new words, trimmed, when they differ from the old ones. */
  readonly onChangeText: (text: string) => void;
  readonly onRemove: () => void;
}

/** Spaces collapsed and trimmed: what the document would store anyway. */
export function cleanHookText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, HOOK_TITLE_MAX_CHARS);
}

export function HookTitleField({
  overlay,
  onChangeText,
  onRemove,
}: HookTitleFieldProps): React.JSX.Element {
  const inputId = useId();
  const [draft, setDraft] = useState(overlay.text);

  // An edit from elsewhere — an undo, another tab — shows here too.
  useEffect(() => {
    setDraft(overlay.text);
  }, [overlay.text]);

  const commit = (): void => {
    const text = cleanHookText(draft);
    // Emptying the field is not how a title comes off: the button below is.
    if (text === "") {
      setDraft(overlay.text);
      return;
    }
    setDraft(text);
    if (text !== overlay.text) onChangeText(text);
  };

  return (
    <div className="flex flex-col gap-2 pb-3" data-testid="hook-title-field">
      <label htmlFor={inputId} className="text-fg-2 text-xs">
        Shown over the first seconds of the video.
      </label>
      <Input
        id={inputId}
        value={draft}
        maxLength={HOOK_TITLE_MAX_CHARS}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(overlay.text);
          }
        }}
        data-testid="hook-title-input"
      />
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          data-testid="hook-title-remove"
        >
          Remove title
        </Button>
      </div>
    </div>
  );
}
