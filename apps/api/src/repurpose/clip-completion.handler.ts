import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import type { Word } from "@montaj/edg/schemas";
import { MediaClipResultSchema } from "@montaj/repurpose-contracts";

import { RepurposeService } from "./repurpose.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/index.js";
import { newestChunkRows } from "../edg/chunk-rows.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { MediaService } from "../media/media.service.js";
import { promoteToRaw } from "../media/probe-restart.js";
import { ProjectsService } from "../projects/projects.service.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";

import type { ObjectStore } from "../common/storage/index.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { Prisma } from "@prisma/client";

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

    if (!clip.run || clip.run.status === "failed" || clip.run.status === "cancelled") {
      this.logger.warn(
        { clipId: clip.id, runId: clip.runId, runStatus: clip.run?.status },
        "media.clip completed for a run that is already failed or cancelled; ignoring completion",
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
        profileVersion: "1",
        captionConfig,
        status: "ready",
      },
      create: {
        id: variantId,
        clipId: clip.id,
        projectId: childProjectId,
        aspect: "r9x16",
        profileVersion: "1",
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

    // 5. Slice and time-shift transcript words for the child project if not already present
    try {
      const existingTranscript = await this.prisma.transcript.findFirst({
        where: { projectId: childProjectId },
      });

      if (!existingTranscript) {
        const sourceTranscript = await this.prisma.transcript.findFirst({
          where: { projectId: clip.run.sourceProjectId },
          orderBy: { createdAt: "desc" },
        });

        if (sourceTranscript) {
          const sourceChunks = await newestChunkRows(this.prisma, sourceTranscript.id);
          const childTranscriptId = ulid();

          await this.prisma.transcript.create({
            data: {
              id: childTranscriptId,
              projectId: childProjectId,
              language: sourceTranscript.language,
              currentRevision: 1,
            },
          });

          const offsetMs = result.effectiveStartMs;
          const clipEndMs = result.effectiveEndMs;
          const shiftedWords: Word[] = [];

          for (const chunk of sourceChunks) {
            const words = (chunk.words as unknown as Word[] | null) ?? [];
            for (const w of words) {
              if (!w.deleted && w.s >= offsetMs && w.e <= clipEndMs) {
                shiftedWords.push({
                  ...w,
                  s: Math.max(0, w.s - offsetMs),
                  e: Math.max(0, w.e - offsetMs),
                });
              }
            }
          }

          if (shiftedWords.length > 0) {
            await this.prisma.transcriptChunk.create({
              data: {
                id: ulid(),
                transcriptId: childTranscriptId,
                revision: 1,
                chunkIdx: 0,
                startMs: 0,
                endMs: result.durationMs,
                words: shiftedWords as unknown as Prisma.InputJsonValue,
                nextWordSeq: shiftedWords.length + 1,
              },
            });
          }
        }
      }
    } catch (transcriptErr) {
      this.logger.warn(
        { err: transcriptErr },
        "could not clone sliced transcript to child project",
      );
    }

    // 6. Start the ordinary media pipeline for the mezzanine — after the
    //    transcript clone, so the proxy's completion finds it. Only for media that
    //    has not entered it yet: a replayed completion must not knock an already
    //    probed asset back to `uploaded`, and the probe enqueue dedupes on the
    //    media id anyway.
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

    // 7. Update run status to review_ready
    const updated = await this.prisma.repurposeRun.update({
      where: { id: clip.run.id },
      data: {
        status: "review_ready",
        currentStage: "review",
        progress: 85,
        failureCode: null,
      },
    });

    await this.runs.publishStage(updated);

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

  async handleFailure(context: JobCompletionContext): Promise<void> {
    const params = context.job.params as Record<string, unknown> | undefined;
    const runId = (params?.["runId"] as string | undefined) ?? "";
    if (!runId) return;

    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    if (!run || ["failed", "cancelled", "published"].includes(run.status)) return;

    const failed = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        failureCode: "repurpose/clip_failed",
      },
    });

    await this.runs.publishStage(failed);
  }
}
