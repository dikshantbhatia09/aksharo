"use client";

/**
 * Copying the words a clips run wrote (2026-09-29): a clip's title, hook and
 * captions, and the episode text.
 *
 * `navigator.clipboard` exists only in a secure context and can be refused
 * (a denied permission, a page without focus). Either way the copy falls back
 * to the old select-and-copy through a hidden text area, and only when both
 * fail does the person hear that it did not work, with what to do instead.
 */
import { Check, Copy } from "lucide-react";
import * as React from "react";

import { Button, toast } from "@montaj/ui";

/** Put `text` on the clipboard. Resolves true when it got there. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: the fallback below may still be allowed.
  }
  return copyThroughSelection(text);
}

function copyThroughSelection(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    // The only way left when the Clipboard API is missing or refused.
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

export const COPY_TEXT_COPY = Object.freeze({
  copy: "Copy",
  copied: "Copied",
  failed: "Could not copy. Select the text and copy it instead.",
});

/** A small "Copy" button; says "Copied" for a moment once it worked. */
export function CopyTextButton({
  text,
  label,
  testId,
}: {
  readonly text: string;
  /** What is copied, for the accessible name: "Copy {label}". */
  readonly label: string;
  readonly testId?: string;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`${COPY_TEXT_COPY.copy} ${label}`}
      data-testid={testId}
      data-copied={copied ? "true" : undefined}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) setCopied(true);
          else toast.error(COPY_TEXT_COPY.failed);
        });
      }}
    >
      {copied ? (
        <Check strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Copy strokeWidth={1.75} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? COPY_TEXT_COPY.copied : COPY_TEXT_COPY.copy}</span>
    </Button>
  );
}
