import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { TranscriptChunkSchema } from "@montaj/edg/schemas";
import {
  DubTrackSchema,
  MediaDubPayloadSchema,
  MediaDubResultSchema,
  type DubLanguage,
  type MediaDubResult,
} from "@montaj/repurpose-contracts";

import { ASPECT_OF_SHAPE } from "../repurpose.constants.js";
import { dubLanguageOption, productLanguageOf } from "./dub-languages.js";
import { RepurposeDubsService } from "./dubs.service.js";
import { wordsFromSrt } from "./srt.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE } from "../../common/storage/index.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";
import { MediaService } from "../../media/media.service.js";
import { PROMOTE_MAX_BYTES, promoteToRaw } from "../../media/probe-restart.js";
import { ProjectsService } from "../../projects/projects.service.js";

import type { ObjectStore } from "../../common/storage/index.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../../jobs/completion-handlers.js";
import type { QueueName } from "../../jobs/contracts/queue-names.js";
import type { Prisma } from "@prisma/client";

/**
 * `media.dub` completions (2026-10-04): one language laid under one shape of a
 * clip becomes that shape's project in that language, the way a clip's own cut
 * becomes its shape's project (`RepurposeClipCompletionHandler`):
 *
 *   1. the project (`<clip title> (4:5, Hindi)`, in the language's own tag) and
 *      its `clip_dub_variants` row, with the clip's own caption setup, so its
 *      document starts on the run's caption style;
 *   2. its primary media: the dubbed video, not yet probed;
 *   3. its transcript, made from the vendor's SRT - the new language's words,
 *      timed within each cue - written BEFORE the pipeline starts, so the
 *      proxy's completion finds it and builds the editing document from it
 *      (`AutoTranscribeTrigger` -> `TranscriptDocumentService`), and never a
 *      copy of the clip's own document: nothing in the clip's language (a hook
 *      title, a series label) comes with the dub;
 *   4. the ordinary media pipeline: a copy in the raw store (the only store it
 *      reads), then `media.probe` -> `media.proxy` -> the document -> `ai.faces`
 *      (free) -> the captioned video, which the dub's reconcile asks for.
 *
 * Only what was asked for is filed: the result's dub, language, shape and key
 * must be the job's own. A replay changes nothing: the row, the media and the
 * transcript are found, not made again, and a media already in its pipeline is
 * not sent through it twice.
 */
@Injectable()
export class RepurposeDubMuxCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeDubMuxCompletionHandler.name);

  readonly jobType: QueueName = "media.dub";

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly media: MediaService,
    private readonly dubs: RepurposeDubsService,
    private readonly registry: JobCompletionRegistry,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const asked = MediaDubPayloadSchema.safeParse(context.job.params);
    const parsed = MediaDubResultSchema.safeParse(context.result);
    if (!asked.success || !parsed.success) {
      throw new Error(
        `media.dub could not be read: ${
          asked.success ? "result" : "payload"
        } does not match media.dub@1`,
      );
    }
    const payload = asked.data;
    const result = parsed.data;
    if (
      result.dubId !== payload.dubId ||
      result.language !== payload.language ||
      result.shape !== payload.shape ||
      result.key !== payload.destination.key
    ) {
      this.logger.error(
        { jobId: context.job.id, asked: payload.destination.key, reported: result.key },
        "media.dub reported a video it was not asked for; nothing applied",
      );
      return { actualTenths: 0, data: { applied: false, reason: "result_mismatch" } };
    }

    const dub = await this.prisma.clipDub.findUnique({
      where: { id: payload.dubId },
      include: { run: true, clip: { include: { variants: true } } },
    });
    if (dub === null) {
      return { actualTenths: 0, data: { applied: false, reason: "dub_not_found" } };
    }
    const language = payload.language;
    const aspect = ASPECT_OF_SHAPE[payload.shape];
    const shapeOfClip = dub.clip.variants.find((variant) => variant.aspect === aspect);
    const runConfig = (dub.run.config as Record<string, unknown> | null) ?? {};
    const captionConfig = (shapeOfClip?.captionConfig ??
      (runConfig["caption"] as Prisma.InputJsonValue | undefined) ??
      {}) as Prisma.InputJsonValue;

    // 1. The shape's project in this language, and its row.
    let row = await this.prisma.clipDubVariant.findUnique({
      where: { dubId_language_aspect: { dubId: dub.id, language, aspect } },
    });
    if (row === null) {
      const project = await this.projects.create(
        dub.workspaceId,
        dub.createdBy ?? dub.run.createdBy ?? "system",
        {
          title: `${dub.clip.title} (${payload.shape}, ${dubLanguageOption(language).name})`,
          sourceLanguage: productLanguageOf(language),
        },
      );
      try {
        row = await this.prisma.clipDubVariant.create({
          data: {
            id: ulid(),
            dubId: dub.id,
            language,
            aspect,
            projectId: project.id,
            captionConfig,
            status: "preparing",
            muxJobId: context.job.id,
          },
        });
      } catch (error) {
        // A replay racing this one made the row first: file into that one, and
        // drop the project this call made for nothing.
        if (!isUniqueViolation(error)) throw error;
        await this.prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
        row = await this.prisma.clipDubVariant.findUniqueOrThrow({
          where: { dubId_language_aspect: { dubId: dub.id, language, aspect } },
        });
      }
    }

    // 2. Its primary media: the dubbed video, not yet probed.
    let media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: row.projectId, role: "primary" },
    });
    media ??= await this.prisma.mediaAsset.create({
      data: {
        id: ulid(),
        projectId: row.projectId,
        filename: "dubbed.mp4",
        mime: "video/mp4",
        bucket: this.raw.kind,
        sizeBytes: BigInt(result.sizeBytes),
        contentHash: result.checksum,
        durationMs: result.durationMs,
        status: "pending",
        role: "primary",
        storageKey: result.key,
      },
    });

    // 3. Its words, in the new language, from the vendor's captions. Best
    //    effort: without them the project is transcribed on its own after its
    //    proxy, which is the fallback every clip has.
    try {
      await this.writeTranscript(row.projectId, language, dub.tracks, result);
    } catch (error) {
      this.logger.warn(
        { dubId: dub.id, language, shape: payload.shape, err: error },
        "could not make the dubbed shape's transcript from its captions",
      );
    }

    // 4. The ordinary media pipeline, once.
    if (result.sizeBytes > PROMOTE_MAX_BYTES) {
      await this.prisma.mediaAsset.update({
        where: { id: media.id },
        data: { status: "failed", failureReason: "media/too_large" },
      });
    } else if (["pending", "uploading", "uploaded"].includes(media.status)) {
      await promoteToRaw({ raw: this.raw, derived: this.derived }, result.key, "video/mp4", {
        overwrite: media.contentHash !== result.checksum,
      });
      const project = await this.prisma.project.findUniqueOrThrow({
        where: { id: row.projectId },
        select: { id: true, workspaceId: true, status: true },
      });
      await this.media.completeAcquisition({
        media,
        project,
        parent: context.job,
        sizeBytes: result.sizeBytes,
        mime: "video/mp4",
        contentHash: result.checksum,
      });
    }

    void this.dubs.reconcileDubSoon(dub.id);
    this.logger.log(
      {
        dubId: dub.id,
        language,
        shape: payload.shape,
        projectId: row.projectId,
        fit: result.fit,
        adjustMs: result.adjustMs,
      },
      "dubbed shape filed; its media pipeline takes it from here",
    );
    return {
      actualTenths: 0,
      data: {
        dubId: dub.id,
        language,
        shape: payload.shape,
        projectId: row.projectId,
        fit: result.fit,
        adjustMs: result.adjustMs,
        applied: true,
      },
    };
  }

  /**
   * The dubbed words as the project's transcript: one transcript, one chunk,
   * written together or not at all, and only when the project has none (a
   * replay finds it). No words, no transcript: a transcript row without words
   * would stop the project ever being transcribed.
   */
  private async writeTranscript(
    projectId: string,
    language: DubLanguage,
    tracksJson: Prisma.JsonValue,
    result: MediaDubResult,
  ): Promise<void> {
    const existing = await this.prisma.transcript.count({ where: { projectId } });
    if (existing > 0) return;
    const track = (Array.isArray(tracksJson) ? tracksJson : [])
      .map((entry) => DubTrackSchema.safeParse(entry))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .find((entry) => entry.language === language);
    if (track?.captions === undefined) return;
    const srt = (await this.derived.get(track.captions.key)).toString("utf8");
    const words = wordsFromSrt(srt, { durationMs: result.durationMs });
    if (words.length === 0) return;
    const chunk = TranscriptChunkSchema.parse({
      chunkIdx: 0,
      startMs: 0,
      endMs: result.durationMs,
      words,
    });
    await this.prisma.$transaction(async (tx) => {
      const transcriptId = ulid();
      await tx.transcript.create({
        data: {
          id: transcriptId,
          projectId,
          language: productLanguageOf(language),
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
          words: words as unknown as Prisma.InputJsonValue,
          nextWordSeq: words.length,
        },
      });
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}
