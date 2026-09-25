"use client";

/**
 * The studio's drop target, in the premium canvas's shape: "Drop video or
 * audio here" over the formats accepted and the plan's real caps.
 *
 * The format line is derived from `@montaj/config`'s allow-list rather than
 * written out, so the copy, the `accept` attribute and the API's own validation
 * cannot disagree about what may be uploaded.
 *
 * The badge quotes no number: the free-stack pipeline (local Whisper on CPU)
 * cannot hold a 60-second promise, and UI never quotes a number the pipeline
 * does not enforce (F07-E1). Drag-drop and a keyboard-reachable file picker both land on the same
 * `onFiles`, so a screen-reader or keyboard-only user has the identical path a
 * mouse gives everyone else — `tabIndex`, `role="button"` and an Enter/Space
 * handler, not a bare `<input>` hidden behind a decoration.
 */
import { UploadCloud } from "lucide-react";
import * as React from "react";

import { useEntitlement } from "@montaj/api-client";
import {
  ALLOWED_MEDIA_EXTENSIONS,
  isAllowedMediaFile,
  MEDIA_ACCEPT_ATTRIBUTE,
} from "@montaj/config";
import { cn, toast } from "@montaj/ui";

/**
 * Every format the API accepts — not a subset of it.
 *
 * This list used to be hand-written here as "a subset of the backend's full
 * allow-list", and the subset is what made `.avi`, `.m4v`, `.mpeg`, `.mpg` and
 * `.3gp` unselectable in the file dialog even though the API would have taken
 * them: the picker greys out anything `accept` does not name, so the file
 * simply could not be chosen and nothing ever reached the server to be logged.
 * `@montaj/config/media-formats` is now the single list both sides read.
 */
export const ACCEPTED_EXTENSIONS = ALLOWED_MEDIA_EXTENSIONS;

export const ACCEPT_ATTRIBUTE = MEDIA_ACCEPT_ATTRIBUTE;

/**
 * The formats named under the drop zone, derived so the copy cannot promise
 * less (or more) than the picker actually accepts.
 *
 * The canvas names four and counts the rest ("MP4, MOV, MP3, WAV and eight
 * more") rather than printing a wall of extensions, and the count is computed
 * from the same list, so it cannot drift when a format is added.
 */
const FORMAT_SUMMARY = ((): string => {
  const all = ACCEPTED_EXTENSIONS.map((extension) => extension.replace(/^\./, "").toUpperCase());
  const named = all.slice(0, 4);
  const rest = all.length - named.length;
  if (rest <= 0) return named.join(", ");
  return `${named.join(", ")} and ${String(rest)} more`;
})();

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)} h`;
  return `${Math.round(ms / 60_000)} min`;
}

export function DropZone({
  onFiles,
  disabled = false,
  variant = "panel",
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /**
   * `"panel"` is the premium canvas's shape: the right-hand half of the "New
   * project" card — a sunken well with a dashed rectangle inset 14 px,
   * a film icon, one line of instruction and one of formats. It is the one the
   * studio uses.
   *
   * `"block"` is the original full-width 240 px box, kept for the onboarding
   * screen and anywhere the drop target *is* the page rather than half a card.
   */
  variant?: "panel" | "block";
}): React.JSX.Element {
  const entitlement = useEntitlement();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const maxFileBytes = entitlement.data?.entitlements["maxFileBytes"];
  const maxDurationMs = entitlement.data?.entitlements["maxDurationMs"];
  const planKey = entitlement.data?.planName;

  const openPicker = (): void => {
    if (!disabled) inputRef.current?.click();
  };

  /**
   * A drop bypasses `accept` entirely — that attribute only filters the file
   * picker — so without this check an unsupported file went all the way to a
   * full client-side hash (minutes, for a large file) before the API answered
   * 415. Refusing it here costs nothing and says why.
   */
  const handleFiles = (list: FileList | null): void => {
    if (list === null || list.length === 0) return;
    const files = Array.from(list);
    const accepted = files.filter((file) => isAllowedMediaFile(file.name, file.type));
    const rejected = files.filter((file) => !isAllowedMediaFile(file.name, file.type));

    if (rejected.length > 0) {
      const names = rejected.map((file) => file.name);
      toast.error(
        rejected.length === 1
          ? `${names[0] ?? "That file"} is not a media file we can read`
          : `${String(rejected.length)} files are not media we can read`,
        { description: `Supported: ${ACCEPTED_EXTENSIONS.join(", ").toUpperCase()}.` },
      );
    }

    // The plan's own cap, checked before anything starts rather than after.
    // `UploadJob` hashes the whole file before `POST /media/init` can answer
    // 413, so an over-cap file used to sit in the tray "Uploading" for the
    // minutes that hash takes and only then report that it was never eligible.
    // `undefined` means the entitlement has not loaded — never block on that.
    const cap = maxFileBytes === undefined ? undefined : Number(maxFileBytes);
    const tooLarge =
      cap === undefined || !Number.isFinite(cap) || cap <= 0
        ? []
        : accepted.filter((file) => file.size > cap);
    if (tooLarge.length > 0 && cap !== undefined) {
      toast.error(
        tooLarge.length === 1
          ? `${tooLarge[0]?.name ?? "That file"} is larger than your plan allows`
          : `${String(tooLarge.length)} files are larger than your plan allows`,
        {
          description: `The ${planKey ?? "current"} plan allows files up to ${formatBytes(cap)}.`,
        },
      );
    }

    const ready = accepted.filter((file) => !tooLarge.includes(file));
    if (ready.length > 0) onFiles(ready);
  };

  return (
    // The `<input>` is a sibling, never a descendant, of the button below: an
    // axe run against an earlier draft (nested-interactive) is what that
    // comment used to explain a `tabIndex={-1}` workaround for — a negative
    // tabindex does not stop assistive tech from reaching a focusable
    // descendant, so the only real fix is not nesting the two at all. The
    // button is what a keyboard or screen-reader user reaches; the input is
    // purely a programmatic trigger for the native file picker.
    <div
      data-testid="drop-zone"
      data-dragging={dragging}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) handleFiles(event.dataTransfer.files);
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={openPicker}
        className={cn(
          "relative flex w-full flex-col items-center justify-center text-center",
          "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
          variant === "panel"
            ? "bg-sunken min-h-[200px] gap-2 p-5"
            : "bg-surface border-border h-[240px] gap-3 rounded-md border px-6 py-8",
          disabled && "cursor-not-allowed opacity-60",
          !disabled && "cursor-pointer hover:bg-neutral-100/5",
          dragging && "bg-accent/8",
        )}
      >
        {/*
          The dashed rectangle is inset rather than being the element's own
          border, which leaves a margin of dark around the invitation. It is a
          neutral dash at rest (3.7:1 against the well, so the target reads
          as a target) and turns rani only while a file is over it: the
          accent marks the one moment the drop will land, not the resting
          state.
        */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-3.5 rounded-md border border-dashed transition-colors",
            dragging ? "border-accent" : "border-neutral-600",
          )}
        />
        <UploadCloud className="text-fg-2 size-6" aria-hidden="true" />
        <span className="text-fg-0 text-sm font-medium">Drop video or audio here</span>
        <span className="text-fg-2 text-xs">or choose a file from this device</span>
        <span className="text-fg-2 text-xs" data-testid="drop-zone-limits">
          {maxFileBytes === undefined || maxDurationMs === undefined
            ? FORMAT_SUMMARY
            : `${FORMAT_SUMMARY} · up to ${formatBytes(Number(maxFileBytes))} and ${formatDuration(
                Number(maxDurationMs),
              )}${planKey === undefined ? "" : ` on ${planKey}`}`}
        </span>
        {/*
          F07-E1: the badge quotes no number, because the free-stack pipeline
          (local Whisper on CPU) cannot hold a 60-second promise and UI never
          quotes a number the pipeline does not enforce. It belongs to the
          full-width variant only — the panel is a well with four lines in it
          and a fifth would crowd the frame.
        */}
        {variant === "block" ? (
          <span
            className="border-border bg-bg-2 text-fg-1 mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
            data-testid="drop-zone-eta-badge"
          >
            Transcription usually takes a few minutes
          </span>
        ) : null}
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        disabled={disabled}
        onClick={(event) => {
          // Without this, picking the same file twice in a row (retry after
          // clearing it) fires no `change` event the second time.
          event.currentTarget.value = "";
        }}
        onChange={(event) => {
          handleFiles(event.target.files);
        }}
        data-testid="drop-zone-input"
      />
    </div>
  );
}
