import { Injectable, Logger, Optional } from "@nestjs/common";

import { firstTranscriptionCanStart, firstTranscriptionJobKey } from "./first-transcription.js";
import { RunCaptionsAligner } from "./run-captions.aligner.js";
import { TranscriptDocumentService } from "./transcript-document.service.js";
import { TranscriptsService } from "./transcripts.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { BACKGROUND_JOB_TYPES, IN_FLIGHT_STATUSES } from "../jobs/admission.service.js";
import { planLimits } from "../jobs/jobs.config.js";
import { JobsService } from "../jobs/jobs.service.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";

/** How many first transcriptions of one media are looked through. There are one or two. */
const ATTEMPT_LOOKBACK = 10;

/**
 * Plan-lane slots an early start needs free: its own, and one more left over.
 * See {@link AutoTranscribeTrigger.laneHasRoomToSpare}.
 */
const EARLY_START_SLOTS = 2;

/**
 * What {@link AutoTranscribeTrigger.startFirstTranscription} did: the job it
 * started or found (`undefined` for none), and what the run's own captions
 * said when they were asked (`"none"` when they were not).
 */
export interface FirstTranscriptionStart {
  readonly jobId: string | undefined;
  readonly captions: "none" | "queued" | "waiting" | "unusable";
}

/** The job types whose open rows mean a producer is writing a transcript right now. */
const TRANSCRIPT_PRODUCERS = ["ai.transcribe", "ai.align"] as const;

/**
 * Start the first transcription as soon as the media can actually be heard.
 *
 * The chain the product promises is upload → probe → proxy → transcript →
 * editing document, and until this existed the last two links were the browser's
 * job. `upload-job.ts` calls `POST /projects/{id}/transcribe` the moment the last
 * part lands — *before* `media.probe` has run — so the API correctly answers
 * `transcript/media_not_ready` (409), the client swallowed it and marked the
 * project "ready", and nothing retried. Probing takes seconds, so that race was
 * lost on essentially every real upload: the project opened with no transcript,
 * `EdgService` had no document to resolve, and the editor dead-ended on "This
 * project has no editing document yet."
 *
 * The fix belongs on the server because the client is the wrong owner for a
 * multi-step chain: a closed tab, a slept laptop or a dropped connection must not
 * decide whether a paid-for upload ever becomes editable.
 *
 * **As soon as it can be heard, not once it is `ready`** (clips pipeline W5,
 * 2026-09-27). `media.proxy` writes `audio16k.wav` back before its 540p encode,
 * and that file is all `ai.transcribe` reads, so the transcription now starts
 * there and runs on the GPU while the encode runs on the CPU
 * (`first-transcription.ts` defines exactly when). That makes this a question
 * asked twice for the same media — when the audio lands, and again when the
 * media is `ready` — and the second ask finds the first's job live under the
 * same key and changes nothing.
 *
 * Safe to call on every write-back of the audio and every `media.proxy` success:
 *
 * - It only acts on the project's **primary** media, once a first transcription
 *   can start on it (`firstTranscriptionCanStart`): `ready`, or its ASR audio
 *   ready ahead of the encode.
 * - **An early start never takes the plan lane's last free slot**
 *   ({@link laneHasRoomToSpare}). The encode it overlaps holds a slot of its
 *   own, so on Free (two) an early start would fill the lane, and a second
 *   upload's probe would be refused for the length of the encode. Without the
 *   spare slot it waits for the `ready` ask, which is where it always started.
 * - With `firstAttemptOnly` (the media pipeline's own calls), it starts one
 *   automatically at most once per media: a first transcription a worker
 *   already ran is not started again when the proxy finishes. Before W5 the
 *   one automatic start came after the proxy, so a failure there was the end of
 *   it; now an early start can fail while the encode still runs, and quietly
 *   starting — and charging for — a second one is not this trigger's call. A
 *   restart is a person's: a run's Try again asks here without the option (the
 *   reconciler), and the editor's start button goes to the producer directly.
 *   One no worker ever ran (refused by the queue, timed out waiting for one, or
 *   cancelled before it began) was not an attempt, and is started again.
 * - A clips run the person stopped, or one that already failed, gets nothing
 *   automatic, early or late: the run says why it stopped, and Try again is the
 *   way back (it reopens the run before it asks).
 * - A project that already has an editing document is left alone, which is what
 *   keeps replace-media (B15 §5) and re-transcription on their own paths rather
 *   than through here.
 * - A project that already has a **transcript but no document** is not
 *   transcribed again — its words exist — but its document is built now, from
 *   those words (`TranscriptDocumentService`). That is a repurposed clip: its
 *   transcript is a slice cloned from the source before its video was probed,
 *   and this is the first moment the probed dimensions that pick the document's
 *   canvas exist — the probe writes them before it enqueues the proxy that
 *   writes the audio, so the early ask has them too (section 13's invariant: a
 *   project with a transcript has an editing document). Without it the clip
 *   never became editable. Unless a transcription is still open: then the
 *   transcript is one its producer is writing right now, and building the
 *   document here would race the producer's own (with its caption preferences,
 *   speakers and segmenter) for the one `edg_documents` row.
 * - `TranscriptsService.transcribe` dedupes on `transcribe:{projectId}:{mediaId}`,
 *   so the browser's eager attempt, the early ask and the `ready` ask collapse to
 *   a single job and a single credit hold, whichever lands first.
 * - A start that finds the media `failed` just after its job was written stops
 *   that job again ({@link stopIfMediaFailed}): the proxy's failure handler
 *   stops what it can see, and this closes the moment it cannot.
 * - A clips run started with captions the person already has (2026-10-01,
 *   `repurpose/run-captions.ts`) is not transcribed at all: the same moment
 *   asks `RunCaptionsAligner` to align those captions to the audio instead,
 *   free, under the same early-start and first-attempt rules. Only captions
 *   that turn out unusable (gone, unreadable, or none inside the part of the
 *   video the run processes) fall through to the paid start below, so the run
 *   still finds its moments - and that is logged, because the start form said
 *   it would be free.
 * - Nothing here can fail the proxy job or the write-back. A workspace out of
 *   credits, or one that never chose a language, simply gets no automatic start;
 *   the failure is logged and the editor still offers to start transcription by
 *   hand. A language of "auto" is a choice — detect it — and is started.
 */
@Injectable()
export class AutoTranscribeTrigger {
  private readonly logger = new Logger(AutoTranscribeTrigger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transcripts: TranscriptsService,
    private readonly documents: TranscriptDocumentService,
    private readonly jobs: JobsService,
    /** Absent in hand-built harnesses: every project is then transcribed as before. */
    @Optional() private readonly captions?: RunCaptionsAligner,
  ) {}

  /**
   * @param options.firstAttemptOnly start nothing when a worker already ran a
   *   first transcription of this media (see the class comment).
   * @returns the enqueued (or already live) job id, or `undefined` when this
   *   media is not a first transcription that can start now.
   */
  async maybeEnqueue(
    mediaId: string,
    options: { readonly firstAttemptOnly?: boolean } = {},
  ): Promise<{ jobId: string } | undefined> {
    const started = await this.start(mediaId, options);
    return started.jobId === undefined ? undefined : { jobId: started.jobId };
  }

  /**
   * {@link maybeEnqueue}, saying also what the run's own captions did
   * (2026-10-01 review). The clips reconciler needs to tell "the captions'
   * align is waiting for a slot" (a wait, free) from "the captions could not
   * be used and the paid fallback did not start" (which may be a balance that
   * is short, and must not read as waiting for ever).
   *
   * `captions` is `"none"` when no captions were consulted: no aligner wired,
   * not a captions run, or the trigger stopped before asking.
   */
  async startFirstTranscription(
    mediaId: string,
    options: { readonly firstAttemptOnly?: boolean } = {},
  ): Promise<FirstTranscriptionStart> {
    return this.start(mediaId, options);
  }

  private async start(
    mediaId: string,
    options: { readonly firstAttemptOnly?: boolean },
  ): Promise<FirstTranscriptionStart> {
    let captions: FirstTranscriptionStart["captions"] = "none";
    const nothing = (): FirstTranscriptionStart => ({ jobId: undefined, captions });
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        projectId: true,
        role: true,
        status: true,
        durationMs: true,
        audio16kKey: true,
        hasAudio: true,
      },
    });
    if (media === null || media.role !== "primary" || !firstTranscriptionCanStart(media)) {
      return nothing();
    }

    const project = await this.prisma.project.findFirst({
      where: { id: media.projectId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        createdBy: true,
        sourceLanguage: true,
        edgDocument: { select: { id: true } },
      },
    });
    if (project === null || project.edgDocument !== null) return nothing();

    // A clips run cancelled after its download finished still reaches here when
    // the proxy completes. Starting a paid transcription for it is spending the
    // user's credits on something they stopped. A failed one is the same: it
    // says why it stopped, and its Try again reopens it before asking here.
    const settledRun = await this.prisma.repurposeRun.findFirst({
      where: { sourceProjectId: project.id, status: { in: ["cancelled", "failed"] } },
      select: { id: true },
    });
    if (settledRun !== null) return nothing();

    const transcripts = await this.prisma.transcript.count({ where: { projectId: project.id } });
    if (transcripts > 0) {
      // A producer mid-write — its transcript is stored and its document is
      // next — gets to finish; the read model makes the same call.
      if (await this.transcriptionOpen(project.id)) return nothing();
      await this.buildDocument(project.id, media.id);
      return nothing();
    }

    const early = media.status !== "ready";
    if (this.captions !== undefined) {
      const seeded = await this.captions.maybeEnqueue(project, media.id, {
        early,
        ...(options.firstAttemptOnly === undefined
          ? {}
          : { firstAttemptOnly: options.firstAttemptOnly }),
        laneHasRoomToSpare: () => this.laneHasRoomToSpare(project.workspaceId),
      });
      if (seeded.kind !== "not_captions") captions = seeded.kind;
      if (seeded.kind === "queued") return { jobId: seeded.jobId, captions };
      if (seeded.kind === "waiting") return nothing();
      if (seeded.kind === "unusable") {
        this.logger.warn(
          { projectId: project.id, mediaId: media.id, reason: seeded.reason },
          "the run's own captions cannot be used; transcribing the video instead",
        );
      }
    }

    // `createdBy` is nullable, and the credit hold has to be attributable to a
    // person; without one there is nobody to charge, so leave it to the editor.
    if (project.createdBy === null) return nothing();

    // No language means the project never went through a quick pick, so there is
    // no defensible guess to spend credits on: leave it to the editor to ask.
    // ("auto" is a pick: the person asked for it to be detected.)
    if (project.sourceLanguage === null || project.sourceLanguage.trim() === "") {
      this.logger.log(
        { projectId: project.id, mediaId: media.id },
        "media is ready but the project has no source language; not auto-transcribing",
      );
      return nothing();
    }

    if (options.firstAttemptOnly === true || early) {
      const earlier = await this.firstTranscriptions(project.workspaceId, project.id, media.id);
      // Asked again while the first ask's job is open: that job is the answer.
      const open = earlier.find((job) => job.status === "queued" || job.status === "running");
      if (open !== undefined) return { jobId: open.id, captions };
      if (options.firstAttemptOnly === true && earlier.some(ranOnWorker)) return nothing();
    }
    if (early && !(await this.laneHasRoomToSpare(project.workspaceId))) {
      this.logger.debug(
        { projectId: project.id, mediaId: media.id },
        "not starting the transcription on the early audio: it would take the plan's last free slot",
      );
      return nothing();
    }

    try {
      const accepted = await this.transcripts.transcribe({
        projectId: project.id,
        workspaceId: project.workspaceId,
        userId: project.createdBy,
        languages: [project.sourceLanguage],
      });
      if (!accepted.deduplicated) {
        this.logger.log(
          { projectId: project.id, mediaId: media.id, jobId: accepted.jobId, status: media.status },
          early
            ? "auto-started the first transcription on the audio, ahead of the video encode"
            : "auto-started the first transcription now that the media is ready",
        );
        if (await this.stopIfMediaFailed(media.id, accepted.jobId, project.workspaceId)) {
          return nothing();
        }
      }
      return { jobId: accepted.jobId, captions };
    } catch (error) {
      // Deliberately swallowed: the proxy genuinely succeeded, and failing its
      // completion would retry the whole proxy rather than the transcription.
      this.logger.warn(
        {
          projectId: project.id,
          mediaId: media.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "could not auto-start transcription; the project opens without one",
      );
      return nothing();
    }
  }

  /** The newest first transcriptions of this media, open or ended. */
  private async firstTranscriptions(
    workspaceId: string,
    projectId: string,
    mediaId: string,
  ): Promise<ReadonlyArray<{ id: string; status: string; startedAt: Date | null }>> {
    return this.prisma.job.findMany({
      where: {
        workspaceId,
        type: "ai.transcribe",
        jobKey: firstTranscriptionJobKey(projectId, mediaId),
      },
      orderBy: { queuedAt: "desc" },
      take: ATTEMPT_LOOKBACK,
      select: { id: true, status: true, startedAt: true },
    });
  }

  /**
   * The plan lane has a slot for an early start AND one more after it
   * ({@link EARLY_START_SLOTS}).
   *
   * The encode the early start overlaps is `media.proxy`, which counts in the
   * lane for as long as it runs; before W5 the pipeline held one slot at a
   * time, and the transcription only followed once the encode had let go of
   * its. Taking the last free slot now would make any other admitted enqueue of
   * the workspace — a second upload's probe, whose refusal fails that upload —
   * answer 429 until the encode ends. Counted exactly as admission counts
   * (`AdmissionService.admit`); a check made just before the enqueue, so two
   * starts at the same instant can still both pass it, which costs no more
   * than the head start was worth.
   */
  private async laneHasRoomToSpare(workspaceId: string): Promise<boolean> {
    try {
      const [plan, inFlight] = await Promise.all([
        resolveWorkspacePlan(this.prisma, workspaceId),
        this.prisma.job.count({
          where: {
            workspaceId,
            status: { in: [...IN_FLIGHT_STATUSES] },
            type: { notIn: [...BACKGROUND_JOB_TYPES] },
          },
        }),
      ]);
      return inFlight + EARLY_START_SLOTS <= planLimits(plan).concurrencyLane;
    } catch (error) {
      // No head start rather than no transcription: the `ready` ask still comes.
      this.logger.warn(
        { workspaceId, error: error instanceof Error ? error.message : String(error) },
        "could not read the plan lane; the transcription waits for the media to be ready",
      );
      return false;
    }
  }

  /** An `ai.transcribe` or `ai.align` of the project is queued or running. */
  private async transcriptionOpen(projectId: string): Promise<boolean> {
    const open = await this.prisma.job.findFirst({
      where: {
        projectId,
        type: { in: [...TRANSCRIPT_PRODUCERS] },
        status: { in: [...IN_FLIGHT_STATUSES] },
      },
      select: { id: true },
    });
    return open !== null;
  }

  /**
   * The media turned out `failed` after this started a transcription of it:
   * stop that transcription, and say so.
   *
   * The proxy's failure handler marks the media failed and then stops the
   * transcriptions it can see; a start that read the media as `probing` a
   * moment before that could still write its job just after the handler's
   * look. Each side writes first and reads second, so one of them always sees
   * the other. Never throws — the job is queued either way, and a failed look
   * leaves it to the run's reconciler.
   */
  private async stopIfMediaFailed(
    mediaId: string,
    jobId: string,
    workspaceId: string,
  ): Promise<boolean> {
    try {
      const now = await this.prisma.mediaAsset.findUnique({
        where: { id: mediaId },
        select: { status: true },
      });
      if (now?.status !== "failed") return false;
      await this.jobs.cancel(jobId, workspaceId);
      this.logger.log(
        { mediaId, jobId },
        "stopped the transcription just started: its media failed as it was queued",
      );
      return true;
    } catch (error) {
      this.logger.warn(
        { mediaId, jobId, error: error instanceof Error ? error.message : String(error) },
        "could not check or stop the transcription of media that may have failed",
      );
      return false;
    }
  }

  /** Same contract as the transcription start: nothing here may fail the proxy job. */
  private async buildDocument(projectId: string, mediaId: string): Promise<void> {
    try {
      const outcome = await this.documents.ensure(projectId);
      if (outcome.status === "created") {
        this.logger.log(
          { projectId, mediaId, edgId: outcome.edgId },
          "built the editing document from the transcript the project already had",
        );
      }
    } catch (error) {
      // The read model repairs on the next look (`transcriptionState`), and says
      // `failed` if it cannot — so logging is enough here.
      this.logger.warn(
        { projectId, mediaId, error: error instanceof Error ? error.message : String(error) },
        "could not build the editing document from the stored transcript",
      );
    }
  }
}

/**
 * A worker ran this first transcription: it succeeded, or failed after a
 * worker picked it up. Not one that never started — the queue refused it
 * (`common/unavailable`), it timed out waiting for a worker, or it was
 * cancelled before it began — and not a cancelled one at all: a person cannot
 * cancel it from the waiting screen, a stopped or failed run is refused above
 * anyway, and the only other canceller is the proxy's failure handler, for
 * media that only a replayed proxy could bring back to `ready`.
 */
function ranOnWorker(job: { readonly status: string; readonly startedAt: Date | null }): boolean {
  if (job.status === "succeeded") return true;
  return job.status === "failed" && job.startedAt !== null;
}
