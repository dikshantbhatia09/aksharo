"use client";

import { Captions, Loader2, ScanSearch } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  ApiError,
  endpoints,
  useProject,
  useRawApiClient,
  useTranscribe,
} from "@montaj/api-client";
import { Button, PageHeader, toast } from "@montaj/ui";

import { ImportSubtitles } from "@/components/editor/ImportSubtitles";
import { LanguagePicker, rememberLanguage } from "@/components/projects/language-picker";
import {
  PROCESSING_TIPS,
  ProcessingScreen,
  useRotatingTip,
} from "@/components/projects/processing-tips";
import {
  announceTranscriptReady,
  getTranscriptionState,
  TRANSCRIPTION_POLL_BACKOFF_MS,
  TRANSCRIPTION_WAITING_STATUSES,
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
 *
 * **S-03 adds the one path that spends no credits at all.** A creator with an
 * SRT/VTT/ASS can import it instead: the route parses it, stores the cues and
 * enqueues `ai.align`, whose completion initialises the editing document the
 * same way a transcription's does. The offer sits under the primary action in
 * every panel where starting work is the question — including the
 * out-of-credits panel, where it is the only thing on screen that still works.
 * The wait it leads to is the local `aligning` phase below.
 *
 * **S-06 gives that wait an ending.** The read model now reports the newest of
 * `ai.transcribe`/`ai.align`, so an alignment that fails answers `failed` here
 * instead of staying invisible: the poll settles on it and the phase renders the
 * failure with a way back to the offer, rather than spinning forever.
 */

export function NeedsTranscription({ projectId }: { projectId: string }): React.JSX.Element {
  const client = useRawApiClient();
  const project = useProject(projectId);
  const transcribe = useTranscribe();

  const [view, setView] = React.useState<TranscriptionStateView | null>(null);
  const [blocked, setBlocked] = React.useState(false);
  const [pollSeq, setPollSeq] = React.useState(0);
  /**
   * S-03: the screen's one local phase — which of the two waits this is. The
   * server's `transcriptionState` reports the newest `ai.transcribe`-or-`ai.align`
   * job (S-06), so the *status* comes from the server either way; what it cannot
   * know is that this particular screen asked for an alignment, and so should say
   * "Aligning…" rather than "Transcribing…" while it runs.
   */
  const [phase, setPhase] = React.useState<"live" | "aligning">("live");
  /**
   * S-06: the user has read the alignment failure and asked for the offer back.
   * The read model cannot help with that — it goes on answering `failed` until a
   * newer job exists — so the dismissal lives here, and any new work (an import
   * or a transcription) clears it.
   */
  const [dismissedAlignment, setDismissedAlignment] = React.useState(false);
  const [chosenLanguage, setChosenLanguage] = React.useState<string | undefined>(undefined);
  const [choosing, setChoosing] = React.useState(false);
  const announced = React.useRef(false);
  // K02: the same rotating "Did you know?" this WP's Prepare-Media modal
  // shows on Home — this screen is the full-screen "Analyzing content" /
  // "Generating subtitles" half of the same trip (reference frames
  // `frame_0055.png`/`frame_0060.png`), reached whenever a person opens the
  // project directly instead of watching from the modal.
  const tip = useRotatingTip(PROCESSING_TIPS);

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
        // S-06: a failed alignment settles the wait too — the read model now sees
        // ai.align, so `failed` here is the alignment's own verdict. Before that
        // it could only ever mean an older transcription, which is why this
        // phase used to wait for `ready` alone (S-03) and spun forever.
        if (
          phase === "aligning"
            ? next.status === "ready" || next.status === "failed"
            : !TRANSCRIPTION_WAITING_STATUSES.has(next.status)
        )
          return;
      } catch {
        // A transient failure must not strand the screen on a stale answer —
        // keep the rhythm and try again on the next tick.
        if (cancelled) return;
      }
      const delay =
        TRANSCRIPTION_POLL_BACKOFF_MS[
          Math.min(attempt, TRANSCRIPTION_POLL_BACKOFF_MS.length - 1)
        ] ?? 15_000;
      attempt += 1;
      timer = setTimeout(() => void tick(), delay);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, projectId, pollSeq, phase]);

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
    setDismissedAlignment(false);
    setPhase("live");
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
      variant="primary"
      onClick={() => void start()}
      disabled={disabled || transcribe.isPending}
      data-testid="editor-start-transcription"
    >
      {transcribe.isPending ? "Starting…" : label}
    </Button>
  );

  /**
   * S-03: the credit-free path, offered *under* the primary action and never
   * instead of it. Taking it clears `blocked` for the same reason `start()`
   * does — a fresh gesture is not still waiting on the last one's 402, and a
   * user who is importing is no longer blocked on credits at all.
   */
  const importOffer = (note: string): React.JSX.Element => (
    <>
      <p className="text-fg-2 text-xs">{note}</p>
      <ImportSubtitles
        projectId={projectId}
        onQueued={() => {
          setBlocked(false);
          setDismissedAlignment(false);
          // The previous alignment's verdict is not this one's. Without this, a
          // second import after a failure renders one frame of the OLD failure
          // (phase `aligning` + a stale `failed`) before the poll's first tick
          // corrects it — `start()` clears the view for the same reason.
          setView(null);
          setPhase("aligning");
        }}
      />
    </>
  );

  const CREDIT_FREE_NOTE =
    "Already have captions? Importing an SRT/VTT costs no transcription credits.";

  /**
   * S-06: both terminal failures read the same — a heading, the failure's own
   * sentence from the read model, and the primary way forward. The alignment's
   * adds a second action, because its input (the sidecar file) is the thing a
   * user can actually change.
   */
  const failedPanel = (
    title: string,
    message: string,
    primaryLabel: string,
    extra?: React.JSX.Element,
  ): React.JSX.Element => (
    <>
      <PageHeader title={title} description={message} />
      <div className="flex flex-wrap items-center gap-2">
        {startButton(primaryLabel, false)}
        {extra}
      </div>
    </>
  );

  /** The default offer, also where "Try another file" lands. */
  const offerPanel = (
    <>
      <PageHeader
        title="This project has not been transcribed yet"
        description="Captions, the timeline and every edit are built from the transcript, so it has to run before the editor opens."
      />
      {startButton("Start transcription", false)}
      {importOffer(CREDIT_FREE_NOTE)}
    </>
  );

  let content: React.JSX.Element;

  if (phase === "aligning" && status === "failed") {
    content = failedPanel(
      "Aligning your subtitles failed",
      view?.error ?? "The alignment failed.",
      "Start transcription",
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          // Leaving the alignment behind is a local decision: the server goes on
          // reporting that failed job until a newer one exists, so the screen
          // remembers the dismissal rather than polling straight back into the
          // panel it just left.
          setPhase("live");
          setDismissedAlignment(true);
        }}
        data-testid="aligning-try-another-file"
      >
        Try another file
      </Button>,
    );
  } else if (phase === "aligning" && status !== "ready") {
    content = (
      <>
        {spinner}
        <PageHeader
          title="Aligning your subtitles…"
          description="Your cues are being timed to the audio. This page updates by itself."
        />
      </>
    );
  } else if (dismissedAlignment) {
    content = offerPanel;
  } else if (blocked) {
    content = (
      <div className="flex flex-col items-start gap-4" data-testid="transcription-blocked-credits">
        <PageHeader
          title="This workspace is out of credits"
          description="Transcription needs credits. Ask an administrator to grant more, then try again. This screen picks it up."
        />
        {startButton("Try again", false)}
        {importOffer(
          "You do not have to wait for credits: importing an SRT/VTT you already " +
            "have costs none at all.",
        )}
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
    // K02: the full-screen "Analyzing content" state (`frame_0055.png`) — the
    // real underlying status is still `processing_media` from FIX-03's read
    // model, this only changes how it is narrated. No progress percentage is
    // shown because none exists yet at this stage (the pulsing indeterminate
    // bar says "working", never a number the pipeline cannot back up).
    content = (
      <ProcessingScreen
        icon={<ScanSearch className="size-7" aria-hidden="true" />}
        headline="Analyzing your media"
        subtext="Transcription starts by itself as soon as the media is ready. This page updates on its own."
        tip={tip}
      />
    );
  } else if (status === "queued" || status === "running") {
    // K02: the full-screen "Generating subtitles" state (`frame_0060.png`).
    content = (
      <ProcessingScreen
        icon={<Captions className="size-7" aria-hidden="true" />}
        headline="Generating your captions"
        subtext="This page updates by itself."
        tip={tip}
      />
    );
  } else if (status === "ready") {
    content = (
      <>
        {spinner}
        <p className="text-fg-2 max-w-md text-sm">Opening the editor…</p>
      </>
    );
  } else if (status === "failed") {
    content = failedPanel(
      "The transcription did not finish",
      view?.error ?? "The transcription failed.",
      "Try again",
    );
  } else if (status === "awaiting_language") {
    content = (
      <>
        <PageHeader
          title="Choose the spoken language"
          description="Transcription starts once you pick one. A wrong guess sends code-mixed speech to the wrong model."
        />
        <LanguagePicker value={chosenLanguage} onChange={(tag) => void chooseLanguage(tag)} />
        {choosing || transcribe.isPending ? (
          <p className="text-fg-2 text-sm" data-testid="awaiting-language-starting">
            Starting transcription…
          </p>
        ) : null}
        {importOffer(CREDIT_FREE_NOTE)}
      </>
    );
  } else if (status === "no_media") {
    content = (
      <>
        <PageHeader
          title="There is nothing to transcribe yet"
          description="This project has no video or audio. Add a file to it first."
        />
        <Button asChild variant="secondary">
          <Link href="/projects">Back to projects</Link>
        </Button>
      </>
    );
  } else {
    content = offerPanel;
  }

  return (
    <div
      className="mx-auto flex h-full min-h-dvh w-full max-w-xl flex-col items-start justify-center gap-4 px-4 py-6 sm:px-6"
      data-testid="editor-needs-transcription"
    >
      {content}
    </div>
  );
}
