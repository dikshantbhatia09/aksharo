import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { makeWordId } from "@montaj/edg";
import { TranscriptChunkSchema, type Word } from "@montaj/edg/schemas";
import { type MediaClipResult, MediaClipResultSchema } from "@montaj/repurpose-contracts";

import { settleRunAfterClips } from "./clip-state.js";
import { CLIP_PROFILE_VERSION } from "./repurpose.constants.js";
import { RepurposeService } from "./repurpose.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/index.js";
import { newestChunkRows } from "../edg/chunk-rows.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { MediaService } from "../media/media.service.js";
import { PROMOTE_MAX_BYTES, promoteToRaw } from "../media/probe-restart.js";
import { ProjectsService } from "../projects/projects.service.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";

import type { ObjectStore } from "../common/storage/index.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { Prisma, RepurposeRun } from "@prisma/client";

/**
 * Run statuses a finished cut moves on to `review_ready`: the run was waiting on
 * its clips. Any other status belongs to another stage and is left alone — a
 * run analysing new suggestions, or one that failed for a reason of its own,
 * keeps saying so while the clip lands beside it.
 */
const ADVANCED_BY_A_CUT: readonly RepurposeRun["status"][] = ["candidates_ready", "materializing"];

/**
 * Written by the code before 2026-09-26, which failed the whole run when one
 * clip failed. A cut that lands on such a run restores it: the clip that failed
 * was the only thing wrong with it.
 */
const LEGACY_CLIP_FAILED = "repurpose/clip_failed";

/**
 * Handles completion of `media.clip` jobs (Wave 6).
 * Updates the `RepurposeClip` record, prepares child `Project` and `ClipVariant`
 * with time-shifted transcript words, and advances the run to `review_ready`.
 *
 * **The child project must end up editable**, which means an editing document,
 * and the editing document is built from probed media. This handler used to
 * stamp the mezzanine `ready` with no probe (no width, height, fps or proxy) and
 * never build a document at all, so every clip opened onto an editor that looped
 * on "Checking this project…". Now the mezzanine joins the ordinary media
 * pipeline the way an acquired source does (`MediaService.completeAcquisition`:
 * `media.probe` as a child job, then `media.proxy`) — with a copy of the
 * mezzanine in the raw store, which is the only store that pipeline reads
 * (`promoteToRaw`) — and the transcript slice is
 * cloned *before* that pipeline starts — so when the proxy lands,
 * `AutoTranscribeTrigger` finds a transcript with no document and builds it
 * (`TranscriptDocumentService`) against the probed dimensions. If the clone
 * fails, the same trigger transcribes the clip from scratch instead: either way
 * the child project is editable.
 *
 * **A clip's failure is the clip's (2026-09-26).** `handleFailure` used to fail
 * the whole run with `repurpose/clip_failed`, which hid every finished clip
 * behind an error card and made this handler drop every sibling cut that
 * landed afterwards. Now the failed job IS the clip's failure — its state is
 * derived from it (`clip-state.ts`) — and the run only moves on once nothing
 * else is still to come.
 */
@Injectable()
export class RepurposeClipCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeClipCompletionHandler.name);

  readonly jobType: QueueName = "media.clip";

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly media: MediaService,
    private readonly runs: RepurposeService,
    private readonly registry: JobCompletionRegistry,
    private readonly realtime: RealtimePublisher,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const parsed = MediaClipResultSchema.safeParse(context.result);
    if (!parsed.success) {
      throw new Error(
        `media.clip returned an invalid result: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const result = parsed.data;

    // The worker reports which clip it cut and where it put it; both must be
    // what this job asked for. Otherwise a worker bug — or a compromised worker
    // (THREAT-MODEL T4, as `assertOwnKeys` holds the proxy to) — could attach
    // any object, another workspace's included, to any clip, and the copy into
    // raw below would then duplicate it under that key. Nothing is written; the
    // job settles, so its lane slot is freed, and the clip reads `failed` with a
    // retry rather than "cutting" forever, which a throw here would leave it.
    const asked = askedFor(context.job.params);
    if (result.clipId !== asked.clipId || result.key !== asked.key) {
      this.logger.error(
        { jobId: context.job.id, clipId: result.clipId, key: result.key, asked },
        "media.clip reported a clip or key it was not asked for; nothing applied",
      );
      await this.handleFailure(context);
      return { actualTenths: 0, data: { applied: false, reason: "result_mismatch" } };
    }

    const clip = await this.prisma.repurposeClip.findUnique({
      where: { id: result.clipId },
      include: { run: true, candidate: true },
    });

    if (!clip) {
      this.logger.warn(
        { clipId: result.clipId },
        "media.clip completed for a clip that no longer exists",
      );
      return { actualTenths: 0, data: { applied: false, reason: "clip_not_found" } };
    }

    // Only a cancelled run turns a finished cut away: the person stopped it. A
    // failed run still gets its clip — dropping it here is how one clip's
    // failure used to throw away every sibling cut still in flight.
    if (!clip.run || clip.run.status === "cancelled") {
      this.logger.warn(
        { clipId: clip.id, runId: clip.runId, runStatus: clip.run?.status },
        "media.clip completed for a run that is cancelled; ignoring completion",
      );
      return {
        actualTenths: 0,
        data: { applied: false, reason: `run_${clip.run?.status ?? "not_found"}` },
      };
    }

    // 1. Update clip mezzanine facts
    await this.prisma.repurposeClip.update({
      where: { id: clip.id },
      data: {
        mezzanineKey: result.key,
        mezzanineChecksum: result.checksum,
        mezzanineDurationMs: result.durationMs,
        mezzanineJobId: context.job.id,
      },
    });

    // 2. Find or create child project for 9:16 variant
    const existingVariant = await this.prisma.clipVariant.findUnique({
      where: {
        clipId_aspect: {
          clipId: clip.id,
          aspect: "r9x16",
        },
      },
    });

    const sourceProject = await this.prisma.project.findUnique({
      where: { id: clip.run.sourceProjectId },
      select: { sourceLanguage: true, scripts: true },
    });

    let childProjectId = existingVariant?.projectId;
    if (!childProjectId) {
      const runConfig = (clip.run.config as Record<string, unknown>) ?? {};
      const sourceLanguage =
        typeof runConfig["sourceLanguage"] === "string"
          ? runConfig["sourceLanguage"]
          : (sourceProject?.sourceLanguage ?? "en");
      const childProject = await this.projects.create(
        clip.run.workspaceId,
        clip.run.createdBy ?? "system",
        {
          title: `${clip.title} (9:16)`,
          sourceLanguage,
        },
      );
      childProjectId = childProject.id;
      // The clip's words are the source's words, so it carries the same scripts
      // — which is what the editing document's script tabs are built from.
      if (sourceProject !== null && sourceProject.scripts.length > 0) {
        await this.prisma.project.update({
          where: { id: childProjectId },
          data: { scripts: sourceProject.scripts },
        });
      }
    }

    // 3. Upsert ClipVariant
    const variantId = existingVariant?.id ?? ulid();
    const runConfig = (clip.run.config as Record<string, unknown>) ?? {};
    const captionConfig = (runConfig["caption"] as Prisma.InputJsonValue) ?? {};
    await this.prisma.clipVariant.upsert({
      where: {
        clipId_aspect: {
          clipId: clip.id,
          aspect: "r9x16",
        },
      },
      update: {
        projectId: childProjectId,
        profileVersion: CLIP_PROFILE_VERSION,
        captionConfig,
        status: "ready",
      },
      create: {
        id: variantId,
        clipId: clip.id,
        projectId: childProjectId,
        aspect: "r9x16",
        profileVersion: CLIP_PROFILE_VERSION,
        captionConfig,
        status: "ready",
      },
    });

    // 4. The child project's primary media: the mezzanine, not yet probed.
    //    `pending` rather than `ready` — it becomes ready the way every other
    //    video does, once `media.probe` and `media.proxy` have measured it and
    //    built the preview the editor plays (step 6).
    let childMedia = await this.prisma.mediaAsset.findFirst({
      where: { projectId: childProjectId, role: "primary" },
    });
    childMedia ??= await this.prisma.mediaAsset.create({
      data: {
        id: ulid(),
        projectId: childProjectId,
        filename: "mezzanine.mp4",
        mime: "video/mp4",
        // Where the copy below puts it — not `result.bucket`, which echoes the
        // bucket requested while the worker writes to the derived store.
        bucket: this.raw.kind,
        sizeBytes: BigInt(result.sizeBytes),
        contentHash: result.checksum,
        durationMs: result.durationMs,
        status: "pending",
        role: "primary",
        storageKey: result.key,
      },
    });

    // 5. The clip's slice of the source transcript, on the clip's own clock.
    //    Best effort by design: if it cannot be cloned, nothing is written and
    //    the proxy's completion transcribes the clip from scratch instead.
    try {
      await this.cloneTranscript(clip.run.sourceProjectId, childProjectId, result);
    } catch (transcriptErr) {
      this.logger.warn(
        { clipId: clip.id, err: transcriptErr },
        "could not clone sliced transcript to child project",
      );
    }

    // 5b. A re-cut of a clip that already has its picture — a new profile (e.g.
    //     "2", which stopped burning captions in) writing new bytes to the same
    //     key. Replace the child's picture and send it through the pipeline
    //     again; the editing document stays (same words, same range), so edits
    //     made to the captions survive. Recognised by the checksum, so a
    //     replayed completion of the SAME cut changes nothing — unless the
    //     child's media FAILED its pipeline, when cutting the clip again is
    //     exactly how a person retries it.
    //
    //     A mezzanine too big to copy into raw (`PROMOTE_MAX_BYTES`) can never
    //     be probed, so no child project can ever be prepared from it. That is
    //     said on the child's media — the clip reads `failed` with the reason and
    //     offers a retry — instead of thrown: a throw leaves this job `running`
    //     for the worker to redeliver, holding one of the plan's lane slots, and
    //     every redelivery gets the same answer.
    const promotable = result.sizeBytes <= PROMOTE_MAX_BYTES;
    if (!promotable) {
      childMedia = await this.prisma.mediaAsset.update({
        where: { id: childMedia.id },
        data: {
          status: "failed",
          failureReason: "media/too_large",
          sizeBytes: BigInt(result.sizeBytes),
          contentHash: result.checksum,
          durationMs: result.durationMs,
        },
      });
      this.logger.warn(
        { clipId: clip.id, mediaId: childMedia.id, sizeBytes: result.sizeBytes },
        "clip mezzanine is too large to prepare; the clip reads failed",
      );
    }
    const recut =
      promotable &&
      (childMedia.status === "failed" ||
        (childMedia.contentHash !== null &&
          childMedia.contentHash !== result.checksum &&
          !["pending", "uploading", "uploaded"].includes(childMedia.status)));
    if (recut) {
      await promoteToRaw({ raw: this.raw, derived: this.derived }, result.key, "video/mp4", {
        overwrite: true,
      });
      // The face track describes the OLD picture, and a re-cut can move the
      // window (a new reframe, a new size). `FacesTrigger` never re-detects a
      // media that has one, so clearing it is what lets the proxy's completion
      // queue `ai.faces` on the new picture — otherwise captions would dodge
      // faces that are no longer where they were.
      const staleFaces = childMedia.facesKey;
      childMedia = await this.prisma.mediaAsset.update({
        where: { id: childMedia.id },
        data: {
          storageKey: result.key,
          sizeBytes: BigInt(result.sizeBytes),
          contentHash: result.checksum,
          durationMs: result.durationMs,
          status: "pending",
          failureReason: null,
          facesKey: null,
        },
      });
      if (staleFaces !== null) {
        // Best effort: the new detection overwrites the same key anyway. This is
        // for the case where it never lands, since retention and erasure only
        // delete the keys a row still names.
        await this.derived.delete(staleFaces).catch((error: unknown) => {
          this.logger.warn(
            { mediaId: childMedia?.id, err: error },
            "could not delete the re-cut clip's old face track",
          );
        });
      }
      this.logger.log(
        { clipId: clip.id, mediaId: childMedia.id },
        "re-cut clip: replacing the child project's picture and re-running its media pipeline",
      );
    }

    // 6. Start the ordinary media pipeline for the mezzanine — after the
    //    transcript clone, so the proxy's completion finds it. Only for media that
    //    has not entered it yet: a replayed completion must not knock an already
    //    probed asset back to `uploaded`, and the probe enqueue dedupes on the
    //    media id anyway. (A mezzanine refused above is `failed`, so never.)
    if (["pending", "uploading", "uploaded"].includes(childMedia.status)) {
      await promoteToRaw({ raw: this.raw, derived: this.derived }, result.key, "video/mp4");
      const childProject = await this.prisma.project.findUniqueOrThrow({
        where: { id: childProjectId },
        select: { id: true, workspaceId: true, status: true },
      });
      await this.media.completeAcquisition({
        media: childMedia,
        project: childProject,
        parent: context.job,
        sizeBytes: result.sizeBytes,
        mime: "video/mp4",
        contentHash: result.checksum,
      });
    }

    // 7. A run that was waiting on its clips has one to review now. The stage is
    //    announced either way, so an open run page fetches the new clip.
    await this.runs.publishStage(await this.advanceRun(clip.run));
    // And the run carries on from what is now true of it — a clip that waited
    // for a slot is the run's next piece of work (docs/repurpose/CLIPS-HARDENING
    // §1). Never throws.
    await this.runs.reconcileRun(clip.run.id);

    this.logger.log(
      { runId: clip.run.id, clipId: clip.id, variantId },
      "Mezzanine clip cut successfully; variant ready for preview & render",
    );

    return {
      data: {
        clipId: clip.id,
        variantId,
        durationMs: result.durationMs,
        applied: true,
      },
    };
  }

  /**
   * A cut that will not be retried again. Nothing is written for the clip: this
   * job, once its row flips to `failed`, is the clip's failure, and the page
   * offers that one clip a retry. The run is never failed for it — it only
   * moves on if this was the last clip it was waiting for.
   */
  async handleFailure(context: JobCompletionContext): Promise<void> {
    const params = context.job.params as Record<string, unknown> | null | undefined;
    const runId = params?.["runId"];
    if (typeof runId !== "string" || runId === "") return;

    const settled = await settleRunAfterClips(this.prisma, runId, {
      finishingJobId: context.job.id,
    });
    if (settled !== undefined) await this.runs.publishStage(settled);
    await this.runs.reconcileRun(runId);
  }

  /**
   * {@link ADVANCED_BY_A_CUT}, plus the repair of a run an older clip failure
   * failed. A compare-and-set on the status as it is NOW, not as `handle` read
   * it: the copy into raw in between can take a while (up to 512 MiB), and a
   * cancel that lands meanwhile must win — an unconditional write would bring
   * the cancelled run back as `review_ready`.
   *
   * @returns the run as it is after this, moved or not, for the announcement.
   */
  private async advanceRun(run: RepurposeRun): Promise<RepurposeRun> {
    await this.prisma.repurposeRun.updateMany({
      where: {
        id: run.id,
        OR: [
          { status: { in: [...ADVANCED_BY_A_CUT] } },
          { status: "failed", failureCode: LEGACY_CLIP_FAILED },
        ],
      },
      data: {
        status: "review_ready",
        currentStage: "review",
        progress: 85,
        failureCode: null,
        completedAt: null,
      },
    });
    return (await this.prisma.repurposeRun.findUnique({ where: { id: run.id } })) ?? run;
  }

  /**
   * Copy the words inside the cut onto the child project, shifted to the clip's
   * own clock, as one transcript with one chunk.
   *
   * - **Word ids are the child's own**, `0:0`…`0:n-1`, with `nextWordSeq` n. The
   *   copy used to keep the source's ids (`2:57`) inside chunk 0, which breaks
   *   the rule every id carries its own chunk's index: the edit path loads chunks
   *   by that prefix, so on a clip from later in a long source every word edit
   *   failed as unknown, and an inserted word was acknowledged and then lost.
   *   One chunk is always enough: a clip is at most 180 s.
   * - **Nothing, or everything.** The transcript and its chunk are written in
   *   one transaction, and only when the slice has words. A transcript row on
   *   its own is worse than none: `AutoTranscribeTrigger` never transcribes a
   *   project that has one, so the clip would open with no captions for good.
   *   Written nothing, the clip is transcribed from scratch after its proxy.
   * - **Unusable timings are not copied.** A source whose words all sit at
   *   zero length (Sarvam transcripts from before 2026-09-17) would put every
   *   word of the whole video on the clip at 0 ms.
   * - **A replay changes nothing** once a transcript with words exists. An empty
   *   transcript left by the code before this — with no editing document built
   *   on it — is replaced in the same transaction.
   */
  private async cloneTranscript(
    sourceProjectId: string,
    childProjectId: string,
    result: MediaClipResult,
  ): Promise<void> {
    const existing = await this.prisma.transcript.findFirst({
      where: { projectId: childProjectId },
      select: { id: true, _count: { select: { chunks: true } } },
    });
    let stale: string | undefined;
    if (existing !== null) {
      if (existing._count.chunks > 0) return;
      // A document built on the empty transcript points at it: leave both.
      const document = await this.prisma.edgDocument.findUnique({
        where: { projectId: childProjectId },
        select: { id: true },
      });
      if (document !== null) return;
      stale = existing.id;
    }

    const source = await this.prisma.transcript.findFirst({
      where: { projectId: sourceProjectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, language: true },
    });
    const sourceWords =
      source === null
        ? []
        : (await newestChunkRows(this.prisma, source.id)).flatMap(
            (chunk) => (chunk.words as unknown as Word[] | null) ?? [],
          );

    const timed = sourceWords.some((word) => word.e > word.s);
    if (!timed && sourceWords.length > 0) {
      this.logger.warn(
        { sourceProjectId, childProjectId, words: sourceWords.length },
        "source transcript has no usable word timings; the clip is transcribed on its own",
      );
    }
    const words: Word[] = timed
      ? sourceWords
          .filter(
            (word) =>
              word.deleted !== true &&
              word.s >= result.effectiveStartMs &&
              word.e <= result.effectiveEndMs,
          )
          .map((word, index) => ({
            ...word,
            wid: makeWordId(0, index),
            s: Math.max(0, word.s - result.effectiveStartMs),
            e: Math.max(0, word.e - result.effectiveStartMs),
          }))
      : [];

    if (source === null || words.length === 0) {
      if (stale !== undefined) await this.prisma.transcript.delete({ where: { id: stale } });
      return;
    }

    // The same invariant the ingest path checks (`transcribe.handler.ts`): a
    // chunk this does not satisfy is not written at all.
    const chunk = TranscriptChunkSchema.parse({
      chunkIdx: 0,
      startMs: 0,
      endMs: result.durationMs,
      words,
    });

    await this.prisma.$transaction(async (tx) => {
      if (stale !== undefined) await tx.transcript.delete({ where: { id: stale } });
      const transcriptId = ulid();
      await tx.transcript.create({
        data: {
          id: transcriptId,
          projectId: childProjectId,
          language: source.language,
          currentRevision: 1,
        },
      });
      await tx.transcriptChunk.create({
        data: {
          id: ulid(),
          transcriptId,
          revision: 1,
          chunkIdx: chunk.chunkIdx,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          // The words as copied, not as parsed: parsing drops fields the schema
          // does not name, and the copy must carry everything the source had.
          words: words as unknown as Prisma.InputJsonValue,
          nextWordSeq: words.length,
        },
      });
    });
  }
}

/**
 * The clip and the destination key a `media.clip` job was enqueued with. Read
 * loosely rather than through `MediaClipPayloadSchema`: jobs the code before
 * 2026-09-26 enqueued carry the same two fields in an older payload.
 */
function askedFor(params: Prisma.JsonValue): { clipId?: unknown; key?: unknown } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
  const destination = params["destination"];
  return {
    clipId: params["clipId"],
    key:
      typeof destination === "object" && destination !== null && !Array.isArray(destination)
        ? destination["key"]
        : undefined,
  };
}
