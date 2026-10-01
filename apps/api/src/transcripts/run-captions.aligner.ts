import { Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE } from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import {
  cuesInWindow,
  importAlignParams,
  parseSidecar,
} from "../media/import/import-align-params.js";
import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "../media/media.constants.js";
import { runCaptionsOf } from "../repurpose/run-captions.js";

import type { ObjectStore } from "../common/storage/index.js";

/** How many earlier aligns of one caption file are looked through. There are one or two. */
const ATTEMPT_LOOKBACK = 10;

/**
 * What {@link RunCaptionsAligner.maybeEnqueue} did.
 *
 * - `not_captions`: the project is not the source of a run started with
 *   captions; transcribe it as usual.
 * - `queued`: the align is queued or running (`jobId`).
 * - `waiting`: a captions run, but nothing is started now - the plan lane has
 *   no room to spare for an early start, an automatic ask found the first
 *   align already ran, or the queue refused the add. The next ask decides again.
 * - `unusable`: the captions cannot be used (the sidecar is gone or unreadable,
 *   or no cue falls inside the part of the video this run processed); the
 *   caller transcribes the video instead, so the run still gets its moments.
 */
export type CaptionsStart =
  | { readonly kind: "not_captions" }
  | { readonly kind: "queued"; readonly jobId: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "unusable"; readonly reason: string };

/**
 * Align a clips run's own captions to its audio, in place of transcribing it
 * (2026-10-01, OpusClip's "upload SRT"; `repurpose/run-captions.ts`).
 *
 * Asked by `AutoTranscribeTrigger` at the moment it would start the paid
 * transcription - the audio written back ahead of the encode, or the media
 * `ready` - because that is the first moment the aligner has something to
 * listen to: `ai.align` reads the same `audio16k.wav` `ai.transcribe` does.
 * Everything after it is the editor import's path, unchanged: the worker
 * answers one flat word list, `AlignCompletionHandler.handleImport` writes the
 * transcript (`provider: "import"`) and builds the editing document, and the
 * run's reconciler finds the transcript and starts looking for moments.
 *
 * The cues are read back from the sidecar the run was created with, not
 * carried in memory or on the run row, and cut to the run's window: a link
 * run of a long video downloads only part of it, while a caption file is timed
 * on the whole video's clock ({@link cuesInWindow}). The window is known by
 * now - the download that wrote it has finished, or the audio would not exist.
 *
 * The job key is the editor import's (`ai.align:{subtitleMediaId}`), so every
 * ask for the same file while one align is open collapses onto it. Free:
 * `MEDIA_JOB_QUOTES.alignTenths` is 0, and nothing here holds credits.
 */
@Injectable()
export class RunCaptionsAligner {
  private readonly logger = new Logger(RunCaptionsAligner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  async maybeEnqueue(
    project: { readonly id: string; readonly workspaceId: string },
    mediaId: string,
    options: {
      /** As `AutoTranscribeTrigger`'s: never start again what a worker already ran. */
      readonly firstAttemptOnly?: boolean;
      /** The audio is ready ahead of the video encode (W5). */
      readonly early: boolean;
      /** Whether an early start leaves the plan lane a slot to spare. */
      readonly laneHasRoomToSpare: () => Promise<boolean>;
    },
  ): Promise<CaptionsStart> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { sourceProjectId: project.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, config: true, windowStartMs: true, windowEndMs: true },
    });
    const captions = run === null ? null : runCaptionsOf(run);
    if (run === null || captions === null) return { kind: "not_captions" };

    const jobKey = MEDIA_JOB_KEYS.align(captions.subtitleMediaId);
    const earlier = await this.prisma.job.findMany({
      where: { workspaceId: project.workspaceId, type: "ai.align", jobKey },
      orderBy: { queuedAt: "desc" },
      take: ATTEMPT_LOOKBACK,
      select: { id: true, status: true, startedAt: true },
    });
    const open = earlier.find((job) => job.status === "queued" || job.status === "running");
    if (open !== undefined) return { kind: "queued", jobId: open.id };
    if (options.firstAttemptOnly === true && earlier.some(ranOnWorker)) return { kind: "waiting" };
    if (options.early && !(await options.laneHasRoomToSpare())) return { kind: "waiting" };

    const sidecarRow = await this.prisma.mediaAsset.findFirst({
      where: { id: captions.subtitleMediaId, projectId: project.id, role: "subtitle" },
      select: { storageKey: true },
    });
    if (sidecarRow === null) return { kind: "unusable", reason: "the caption file is gone" };

    let raw: Buffer;
    try {
      raw = await this.derived.get(sidecarRow.storageKey);
    } catch (error) {
      // A store that blinked is a wait, not a reason to spend credits.
      this.logger.warn(
        { runId: run.id, error: error instanceof Error ? error.message : String(error) },
        "could not read the run's captions; the align waits for the next ask",
      );
      return { kind: "waiting" };
    }
    const sidecar = parseSidecar(raw.toString("utf8"));
    if (sidecar === null) return { kind: "unusable", reason: "the caption file is unreadable" };

    const cues = cuesInWindow(sidecar.cues, {
      startMs: run.windowStartMs ?? 0,
      endMs: run.windowEndMs ?? null,
    }).filter((cue) => cue.text.trim() !== "");
    if (cues.length === 0) {
      return {
        kind: "unusable",
        reason: "no caption falls inside the part of the video this run processes",
      };
    }

    try {
      const { job } = await this.jobs.enqueue({
        type: "ai.align",
        workspaceId: project.workspaceId,
        projectId: project.id,
        params: importAlignParams({
          transcriptId: ulid(),
          subtitleMediaId: captions.subtitleMediaId,
          subtitleKey: sidecarRow.storageKey,
          subtitleBucket: this.derived.kind,
          mediaId,
          kind: sidecar.kind,
          timed: sidecar.timed,
          language: sidecar.language,
          cues,
        }),
        jobKey,
        worstCaseTenths: MEDIA_JOB_QUOTES.alignTenths,
        reason: `ai.align · run captions ${sidecar.kind} · ${String(cues.length)} cues`,
      });
      this.logger.log(
        { runId: run.id, projectId: project.id, mediaId, jobId: job.id, cues: cues.length },
        "aligning the run's own captions instead of transcribing",
      );
      return { kind: "queued", jobId: job.id };
    } catch (error) {
      // Refused for now (a full lane, a queue that is down): the reconciler and
      // the media pipeline ask again, and land here again, not on a paid start.
      this.logger.warn(
        { runId: run.id, error: error instanceof Error ? error.message : String(error) },
        "could not queue the align of the run's captions; it waits for the next ask",
      );
      return { kind: "waiting" };
    }
  }
}

/** A worker ran this align: it succeeded, or failed after a worker picked it up. */
function ranOnWorker(job: { readonly status: string; readonly startedAt: Date | null }): boolean {
  if (job.status === "succeeded") return true;
  return job.status === "failed" && job.startedAt !== null;
}
