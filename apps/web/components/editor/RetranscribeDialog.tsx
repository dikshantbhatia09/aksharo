"use client";

/**
 * "Re-transcribe" — the editor's recovery path when the language was wrong
 * (FIX-04 step 3).
 *
 * Until now the server route existed and nothing could reach it, so a project
 * transcribed in the wrong language was a dead project. The dialog is small on
 * purpose: pick a language, read what it costs you, confirm.
 *
 * Two honest refusals are surfaced rather than smoothed over:
 *
 * 1. **`transcript/has_edits` (409).** A new transcription mints new word ids,
 *    and captions the user retimed, split or retyped are addressed by the old
 *    ones — so those edits do not survive. The server refuses by default and
 *    this asks a second, differently-worded question before resending with
 *    `force: true`. The warning quotes the server's own rule so the two can
 *    never drift apart.
 * 2. **No `announceTranscriptReady` on 202.** The job has been *accepted*, not
 *    finished. FIX-03's pipeline (the shell's push, or the waiting screen's
 *    poll) announces the new document when it actually exists; until then the
 *    editor keeps showing the old one, which is the only document there is.
 *
 * `defineEndpoint` is `@montaj/api-client`'s documented escape hatch for a
 * route the curated hooks do not cover — the same pattern
 * `lib/edg/transcription-state.ts` and `lib/timeline/use-timeline-media.ts`
 * use. The shape is copied from `RetranscribeRequestDto`
 * (`apps/api/src/transcripts/transcripts.dto.ts:56`) and
 * `TranscribeAcceptedDto`.
 */

import * as React from "react";

import { ApiError, defineEndpoint, useRawApiClient } from "@montaj/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@montaj/ui";

import { LanguagePicker, rememberLanguage } from "@/components/projects/language-picker";
import { messageForError } from "@/lib/errors";

interface RetranscribeRequest {
  readonly languages?: readonly string[];
  readonly hints?: readonly string[];
  /** Proceed even though the captions have been edited (`transcript/has_edits`). */
  readonly force?: boolean;
}

interface TranscribeAccepted {
  readonly jobId: string;
  readonly transcriptId: string;
  readonly status: string;
  readonly deduplicated: boolean;
}

export const retranscribeProject = defineEndpoint<RetranscribeRequest, TranscribeAccepted>({
  method: "POST",
  path: "/projects/{projectId}/transcript/retranscribe",
  auth: "bearer",
});

/** The server's rule, quoted (`transcripts.controller.ts`'s `retranscribe`). */
const EDITS_WARNING =
  "Re-transcribing replaces every word id. Captions you have retimed, split or retyped will lose those edits.";

export interface RetranscribeDialogProps {
  readonly projectId: string;
  /** The project's current `sourceLanguage`, or `null` when it never had one. */
  readonly sourceLanguage: string | null;
  /**
   * OC-02: Language → Re-transcribe… opens this from the menubar, so the
   * dialog can be driven from outside. Standard controlled/uncontrolled pair —
   * omit both and the component keeps its own state and its own button, which
   * is what every existing mount and this file's own tests still do. A
   * *controlled* mount renders no trigger: the menu item is the trigger, and a
   * second button beside it in the header is the duplicate chrome OC-02 exists
   * to remove.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function RetranscribeDialog({
  projectId,
  sourceLanguage,
  open: openProp,
  onOpenChange,
}: RetranscribeDialogProps): React.JSX.Element {
  const client = useRawApiClient();
  const [selfOpen, setSelfOpen] = React.useState(false);
  const controlled = openProp !== undefined;
  const open = openProp ?? selfOpen;
  const setOpen = React.useCallback(
    (next: boolean): void => {
      if (!controlled) setSelfOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const [language, setLanguage] = React.useState<string | undefined>(sourceLanguage ?? undefined);
  const [confirmingEdits, setConfirmingEdits] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Reopening the dialog starts from the project's language again, not from
  // whatever was half-chosen and abandoned last time.
  React.useEffect(() => {
    if (!open) return;
    setLanguage(sourceLanguage ?? undefined);
    setConfirmingEdits(false);
  }, [open, sourceLanguage]);

  async function submit(force: boolean): Promise<void> {
    if (language === undefined) return;
    setBusy(true);
    try {
      await client.call(retranscribeProject, {
        params: { projectId },
        body: { languages: [language], hints: [], force },
      });
      rememberLanguage(language);
      setOpen(false);
      setConfirmingEdits(false);
      // Deliberately no `announceTranscriptReady` — see the file comment.
      toast.success("Transcribing again…", {
        description: "The editor updates itself when the new transcript is ready.",
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "transcript/has_edits") {
        setConfirmingEdits(true);
        return;
      }
      toast.error("Could not start the transcription", { description: messageForError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {controlled ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-fg-3 text-xs"
          onClick={() => setOpen(true)}
          data-testid="retranscribe-open"
        >
          Re-transcribe
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="retranscribe-dialog">
          <DialogHeader>
            <DialogTitle>Transcribe this again?</DialogTitle>
            <DialogDescription>
              Pick the language actually spoken in this video. The transcription runs again from the
              media and replaces the current transcript.
            </DialogDescription>
          </DialogHeader>

          <LanguagePicker value={language} onChange={setLanguage} />

          <p
            className="border-border text-fg-2 rounded-md border border-dashed p-3 text-sm"
            data-testid="retranscribe-warning"
          >
            {EDITS_WARNING}
          </p>

          {confirmingEdits ? (
            <p className="text-amber-200 text-sm" role="alert" data-testid="retranscribe-has-edits">
              This project already has caption edits. Continuing discards them.
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {confirmingEdits ? (
              <Button
                type="button"
                variant="primary"
                disabled={busy || language === undefined}
                onClick={() => void submit(true)}
                data-testid="retranscribe-force"
              >
                I understand — replace my edits
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                disabled={busy || language === undefined}
                onClick={() => void submit(false)}
                data-testid="retranscribe-confirm"
              >
                Re-transcribe
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
