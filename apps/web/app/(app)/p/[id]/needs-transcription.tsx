"use client";

import { Loader2 } from "lucide-react";
import * as React from "react";

import {
  ApiError,
  endpoints,
  useProject,
  useRawApiClient,
  useTranscribe,
} from "@montaj/api-client";
import { Button, toast } from "@montaj/ui";

import { LanguagePicker, rememberLanguage } from "@/components/projects/language-picker";
import {
  announceTranscriptReady,
  getTranscriptionState,
  type TranscriptionStateView,
} from "@/lib/edg/transcription-state";
import { messageForError } from "@/lib/errors";

/**
 * What the editor shows when a project has no editing document yet.
 *
 * The document is written when a transcription completes, so "no document" means
 * the first transcription has not finished. Which of the several reasons for that
 * is true is not this screen's guess to make: FIX-03 moved it to the server as
 * `GET /projects/{id}/transcription-state`, and this component renders exactly
 * what comes back.
 *
 * **Push first, poll as the fallback.** `AppShell` announces a finished
 * transcription over the realtime channel and the editor's store reloads under
 * this screen, which unmounts it. The poll below exists for when that channel is
 * down or the tab missed the frame — so it runs only while the answer is still
 * moving (`queued`, `running`, `processing_media`), backs off 4 s -> 8 s -> 15 s,
 * and stops on any settled state. Bounded by the screens actually waiting, never
 * by how many users are registered.
 *
 * **`awaiting_language` is the one state with a question in it** (FIX-04). A
 * project reaches it when nothing ever recorded a spoken language — which used
 * to be impossible to escape from the UI, because Home stamped `hi-Latn` on
 * everything and nothing else could write the field. The picker below is that
 * escape: one gesture records the language *and* starts the work, because
 * choosing the language after being told what it costs IS the consent. Asking
 * for a second click would only be ceremony.
 */

/** 4 s -> 8 s -> 15 s, then 15 s for as long as the screen is genuinely waiting. */
const POLL_BACKOFF_MS = [4_000, 8_000, 15_000] as const;

/** The states that are still moving — the only ones worth another request. */
const WAITING: ReadonlySet<TranscriptionStateView["status"]> = new Set([
  "queued",
  "running",
  "processing_media",
]);

export function NeedsTranscription({ projectId }: { projectId: string }): React.JSX.Element {
  const client = useRawApiClient();
  const project = useProject(projectId);
  const transcribe = useTranscribe();

  const [view, setView] = React.useState<TranscriptionStateView | null>(null);
  const [blocked, setBlocked] = React.useState(false);
  const [pollSeq, setPollSeq] = React.useState(0);
  const [chosenLanguage, setChosenLanguage] = React.useState<string | undefined>(undefined);
  const [choosing, setChoosing] = React.useState(false);
  const announced = React.useRef(false);

  const language = project.data?.sourceLanguage ?? null;
  const status = view?.status;

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function tick(): Promise<void> {
      try {
        const next = await client.call(getTranscriptionState, { params: { projectId } });
        if (cancelled) return;
        setView(next);
        // Settled: stop asking. `ready` unmounts this screen a moment later.
        if (!WAITING.has(next.status)) return;
      } catch {
        // A transient failure must not strand the screen on a stale answer —
        // keep the rhythm and try again on the next tick.
        if (cancelled) return;
      }
      const delay = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)] ?? 15_000;
      attempt += 1;
      timer = setTimeout(() => void tick(), delay);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, projectId, pollSeq]);

  // The poll won the race with the websocket (or the websocket is gone): tell the
  // editor's store, once, and it reloads the document under this screen.
  React.useEffect(() => {
    if (status === "ready" && !announced.current) {
      announced.current = true;
      announceTranscriptReady(projectId);
    }
  }, [status, projectId]);

  async function start(chosen?: string): Promise<void> {
    setBlocked(false);
    const tag = chosen ?? language;
    try {
      const accepted = await transcribe.mutateAsync({
        projectId,
        // No recorded language means auto-detect rather than a guess that would
        // route the wrong lane for code-mixed speech.
        ...(tag === null || tag === undefined ? {} : { languages: [tag] }),
        hints: [],
      });
      // `transcript/media_not_ready`: the server pipeline owns what happens next
      // (auto-transcribe on proxy completion), so say so and keep watching.
      setView(
        accepted === null
          ? { status: "processing_media" }
          : { status: "queued", jobId: accepted.jobId },
      );
      setPollSeq((seq) => seq + 1);
    } catch (error) {
      // The 402 is the credit UX, not a failure: surfaced in place so the user
      // can act, instead of a toast that disappears.
      if (error instanceof ApiError && error.code === "credits/insufficient") {
        setBlocked(true);
        return;
      }
      toast.error("Could not start transcription", { description: messageForError(error) });
    }
  }

  /**
   * FIX-04 step 2: record the language on the project, then start the work.
   *
   * The PATCH comes first and its failure is fatal to the gesture — starting a
   * transcription whose language the project does not carry is exactly the
   * split-brain the audit found (the transcript said one thing, the project
   * another). `sourceLanguage` is already on `updateProjectSchema`
   * (`apps/api/src/projects/projects.dto.ts:46`), so no DTO change and no
   * `gen:client` are needed here.
   */
  async function chooseLanguage(tag: string): Promise<void> {
    setChosenLanguage(tag);
    setChoosing(true);
    try {
      await client.call(endpoints.projects.update, {
        params: { projectId },
        body: { sourceLanguage: tag },
      });
    } catch (error) {
      setChoosing(false);
      toast.error("Could not save the language", { description: messageForError(error) });
      return;
    }
    rememberLanguage(tag);
    void project.refetch();
    await start(tag);
    setChoosing(false);
  }

  const spinner = <Loader2 className="text-fg-2 size-6 animate-spin" aria-hidden="true" />;
  const startButton = (label: string, disabled: boolean): React.JSX.Element => (
    <Button
      type="button"
      onClick={() => void start()}
      disabled={disabled || transcribe.isPending}
      data-testid="editor-start-transcription"
    >
      {transcribe.isPending ? "Starting…" : label}
    </Button>
  );

  let content: React.JSX.Element;

  if (blocked) {
    content = (
      <div className="flex flex-col items-center gap-3" data-testid="transcription-blocked-credits">
        <h2 className="text-fg-0 text-lg font-semibold">This workspace is out of credits</h2>
        <p className="text-fg-2 max-w-md text-sm">
          Transcription needs credits. Ask an administrator to grant more, then come back — this
          screen will pick it up.
        </p>
        {startButton("Try again", false)}
      </div>
    );
  } else if (status === undefined) {
    content = (
      <>
        {spinner}
        <p className="text-fg-2 max-w-md text-sm">Checking this project…</p>
      </>
    );
  } else if (status === "processing_media") {
    content = (
      <>
        {spinner}
        <h2 className="text-fg-0 text-lg font-semibold">Preparing your media…</h2>
        <p className="text-fg-2 max-w-md text-sm">
          Transcription starts by itself as soon as the media is ready.
        </p>
      </>
    );
  } else if (status === "queued" || status === "running") {
    content = (
      <>
        {spinner}
        <h2 className="text-fg-0 text-lg font-semibold">Transcribing…</h2>
        <p className="text-fg-2 max-w-md text-sm">This page updates by itself.</p>
      </>
    );
  } else if (status === "ready") {
    content = (
      <>
        {spinner}
        <p className="text-fg-2 max-w-md text-sm">Opening the editor…</p>
      </>
    );
  } else if (status === "failed") {
    content = (
      <>
        <h2 className="text-fg-0 text-lg font-semibold">The transcription did not finish</h2>
        <p className="text-fg-2 max-w-md text-sm">{view?.error ?? "The transcription failed."}</p>
        {startButton("Try again", false)}
      </>
    );
  } else if (status === "awaiting_language") {
    content = (
      <>
        <h2 className="text-fg-0 text-lg font-semibold">
          Choose the spoken language to transcribe
        </h2>
        <p className="text-fg-2 max-w-md text-sm">
          Transcription is not started without one — a wrong guess routes the wrong lane for
          code-mixed speech.
        </p>
        <LanguagePicker
          value={chosenLanguage}
          onChange={(tag) => void chooseLanguage(tag)}
          className="justify-center"
        />
        {choosing || transcribe.isPending ? (
          <p className="text-fg-2 text-sm" data-testid="awaiting-language-starting">
            Starting transcription…
          </p>
        ) : null}
      </>
    );
  } else if (status === "no_media") {
    content = (
      <>
        <h2 className="text-fg-0 text-lg font-semibold">There is nothing to transcribe yet</h2>
        <p className="text-fg-2 max-w-md text-sm">Upload a video to this project first.</p>
      </>
    );
  } else {
    content = (
      <>
        <h2 className="text-fg-0 text-lg font-semibold">
          This project has not been transcribed yet
        </h2>
        <p className="text-fg-2 max-w-md text-sm">
          Captions, the timeline and every edit are built from the transcript, so that has to run
          first.
        </p>
        {startButton("Start transcription", false)}
      </>
    );
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="editor-needs-transcription"
    >
      {content}
    </div>
  );
}
