"use client";

/**
 * The Home drop zone (08 §Home): "Drop videos or audio here · up to 4 GB / 3 h
 * on Creator · MP4 MOV MKV WEBM MP3 WAV" plus the "Transcription in ~60 s"
 * badge. Drag-drop and a keyboard-reachable file picker both land on the same
 * `onFiles`, so a screen-reader or keyboard-only user has the identical path a
 * mouse gives everyone else — `tabIndex`, `role="button"` and an Enter/Space
 * handler, not a bare `<input>` hidden behind a decoration.
 */
import { UploadCloud } from "lucide-react";
import * as React from "react";

import { useEntitlement } from "@montaj/api-client";
import { cn } from "@montaj/ui";

/** The brief's own list (07 F-101): a subset of the backend's full allow-list. */
export const ACCEPTED_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "mp3",
  "wav",
  "m4a",
  "aac",
] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

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
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
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

  const handleFiles = (list: FileList | null): void => {
    if (list === null || list.length === 0) return;
    onFiles(Array.from(list));
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
          "border-border bg-bg-1 flex w-full flex-col items-center gap-3 rounded-md border-2 border-dashed",
          "px-6 py-12 text-center transition-colors duration-[160ms]",
          dragging && "border-lime-500 bg-lime-500/5",
          disabled && "cursor-not-allowed opacity-60",
          !disabled && "cursor-pointer hover:border-lime-500/60",
        )}
      >
        <UploadCloud className="text-fg-2 size-8" aria-hidden="true" />
        <p className="text-fg-0 text-base font-medium">Drop videos or audio here</p>
        <p className="text-fg-2 text-sm" data-testid="drop-zone-limits">
          {maxFileBytes === undefined || maxDurationMs === undefined
            ? "MP4 MOV MKV WEBM MP3 WAV M4A AAC"
            : `Up to ${formatBytes(Number(maxFileBytes))} / ${formatDuration(Number(maxDurationMs))}${
                planKey === undefined ? "" : ` on ${planKey}`
              } · MP4 MOV MKV WEBM MP3 WAV M4A AAC`}
        </p>
        <span
          className="border-lime-500/40 bg-lime-500/10 text-lime-500 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
          data-testid="drop-zone-eta-badge"
        >
          Transcription in ~60 s
        </span>
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
