"use client";

import * as React from "react";

import { ApiError, useProject, useTranscribe } from "@montaj/api-client";
import { Button, toast } from "@montaj/ui";

import { messageForError } from "@/lib/errors";

/**
 * What the editor shows when a project has no editing document yet.
 *
 * The document is written when a transcription completes, so "no document" means
 * the first transcription never ran. `AutoTranscribeTrigger` (API) now starts it
 * as soon as the media is ready, but that cannot be the only answer: a workspace
 * that was out of credits at the time, a project created without a language, or
 * anything uploaded before that fix still lands here. A dead end with a red
 * sentence was the worst possible response — the work is one click away.
 */
export function NeedsTranscription({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useProject(projectId);
  const transcribe = useTranscribe();
  const [started, setStarted] = React.useState(false);

  const language = project.data?.sourceLanguage ?? null;

  async function start(): Promise<void> {
    try {
      const accepted = await transcribe.mutateAsync({
        projectId,
        // No recorded language means auto-detect rather than a guess that would
        // route the wrong lane for code-mixed speech.
        ...(language === null ? {} : { languages: [language] }),
        hints: [],
      });
      if (accepted === null) {
        toast.info("The media is still processing", {
          description: "Give it a moment and try again.",
        });
        return;
      }
      setStarted(true);
      toast.success("Transcription started", {
        description: "The editor opens by itself when the transcript is ready.",
      });
    } catch (error) {
      const description =
        error instanceof ApiError && error.code === "credits/insufficient"
          ? "This workspace is out of credits. Ask an administrator to grant more."
          : messageForError(error);
      toast.error("Could not start transcription", { description });
    }
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="editor-needs-transcription"
    >
      <h2 className="text-fg-0 text-lg font-semibold">This project has not been transcribed yet</h2>
      <p className="text-fg-2 max-w-md text-sm">
        {started
          ? "Transcribing now. This page updates by itself when the transcript is ready."
          : "Captions, the timeline and every edit are built from the transcript, so that has to run first."}
      </p>
      <Button
        type="button"
        onClick={() => void start()}
        disabled={transcribe.isPending || started}
        data-testid="editor-start-transcription"
      >
        {transcribe.isPending ? "Starting…" : started ? "Transcribing…" : "Start transcription"}
      </Button>
    </div>
  );
}
