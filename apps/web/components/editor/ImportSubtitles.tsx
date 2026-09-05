"use client";

import { FileUp, Loader2 } from "lucide-react";
import * as React from "react";

import { useRawApiClient } from "@montaj/api-client";
import { Button, DropdownMenuItem, toast } from "@montaj/ui";

import {
  importSubtitles,
  SUBTITLE_ACCEPT,
  SUBTITLE_MAX_BYTES,
  subtitleKindFor,
} from "@/lib/edg/import-subtitles";
import { messageForError } from "@/lib/errors";

/**
 * S-03: bring your own captions.
 *
 * A creator who already has an SRT/VTT/ASS gets captions without spending a
 * transcription credit — the server parses the file into one normalised cue
 * list, stores it as a sidecar and enqueues `ai.align`, whose completion
 * initialises the editing document exactly the way a transcription's does. The
 * route was built and had zero callers; this control is the caller.
 *
 * Deliberately thin: no client-side gating beyond the size the schema itself
 * enforces (`IMPORT_MAX_BYTES`) and the extension the schema's `kind` enum
 * accepts. Everything else — a project that already has a transcript, a rate
 * limit, a file the parsers cannot read — is the route's answer to give, and
 * the toast repeats it verbatim. A malformed SRT's parse message is genuinely
 * useful; inventing a friendlier one would throw it away.
 */
export function ImportSubtitles({
  projectId,
  onQueued,
  variant = "button",
}: {
  projectId: string;
  /** Fired once the route has accepted the file and the align job is enqueued. */
  onQueued?: () => void;
  /** `menu-item` renders the same behaviour as a row inside a dropdown menu. */
  variant?: "button" | "menu-item";
}): React.JSX.Element {
  const client = useRawApiClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  async function send(file: File): Promise<void> {
    // The schema's ceiling, checked before the file is read: 2 MB of text is
    // the parser's input budget, not a media limit.
    if (file.size > SUBTITLE_MAX_BYTES) {
      toast.error("That file is too large for a subtitle import");
      return;
    }
    const kind = subtitleKindFor(file.name);
    if (kind === null) {
      toast.error("That file is not a subtitle file", {
        description: "Choose an .srt, .vtt, .ass or .txt file.",
      });
      return;
    }

    setBusy(true);
    try {
      const content = await file.text();
      await client.call(importSubtitles, {
        params: { projectId },
        body: { kind, content },
      });
      toast.success("Subtitles imported", {
        description: "Aligning them to your audio — the editor opens by itself.",
      });
      onQueued?.();
    } catch (error) {
      toast.error("Could not import those subtitles", { description: messageForError(error) });
    } finally {
      setBusy(false);
    }
  }

  const open = (): void => inputRef.current?.click();

  // Not nested inside the trigger: a file input inside a button is axe's
  // `nested-interactive`, and inside a `DropdownMenuItem` it is the same
  // defect. `drop-zone.tsx` shapes it the same way.
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={SUBTITLE_ACCEPT}
      className="sr-only"
      aria-hidden="true"
      tabIndex={-1}
      onClick={(event) => {
        // Without this, picking the same file twice in a row (a retry after a
        // parse error) fires no `change` event the second time.
        event.currentTarget.value = "";
      }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file !== undefined) void send(file);
      }}
      data-testid="import-subtitles-input"
    />
  );

  if (variant === "menu-item") {
    return (
      <>
        <DropdownMenuItem
          // `preventDefault` keeps the menu mounted: selecting an item normally
          // closes it, which would unmount the file input before the picker
          // could return a file.
          onSelect={(event) => {
            event.preventDefault();
            open();
          }}
          disabled={busy}
          data-testid="import-subtitles"
        >
          <FileUp aria-hidden="true" />
          {busy ? "Importing…" : "Import subtitles"}
        </DropdownMenuItem>
        {input}
      </>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={open}
        disabled={busy}
        data-testid="import-subtitles"
      >
        {busy ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <FileUp aria-hidden="true" />
        )}
        {busy ? "Importing…" : "Import subtitles"}
      </Button>
      {input}
    </>
  );
}
