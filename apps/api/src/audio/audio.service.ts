import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { newId } from "@montaj/edg";

import { AUDIO_ERROR_CODES } from "./audio.errors.js";
import { quoteAudioClean } from "./audio.quote.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE } from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";

import type { AudioCleanQuote } from "./audio.quote.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { AudioClean, MediaAsset, Project } from "@prisma/client";

/** How long a signed GET on a clean's output stays valid. */
const SIGNED_URL_TTL_S = 3_600;

export interface RequestCleanInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly mediaId?: string;
  readonly strength: "light" | "medium" | "strong";
  readonly target: "social" | "youtube" | "podcast";
  readonly dereverb?: boolean;
  readonly deesser?: boolean;
}

export interface RequestCleanResult {
  readonly jobId: string;
  readonly cleanId: string;
  readonly status: string;
  readonly deduplicated: boolean;
  readonly quote: AudioCleanQuote;
}

export interface AudioCleanView {
  readonly id: string;
  readonly projectId: string;
  readonly mediaId: string;
  readonly strength: string;
  readonly target: string;
  readonly dereverb: boolean;
  readonly deesser: boolean;
  readonly status: string;
  readonly jobId: string | null;
  readonly metrics: Record<string, unknown> | undefined;
  readonly cleanedAudioUrl: string | undefined;
  readonly previewOriginalUrl: string | undefined;
  readonly previewCleanedUrl: string | undefined;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | undefined;
}

/**
 * The audio-clean feature: quote + enqueue `ai.clean`, and the reads a project's
 * clean history needs (B10).
 *
 * Mirrors `transcripts/transcripts.service.ts`'s producing shape: resolve the
 * project and its media, quote from the probed duration, mint the row's id
 * up front so it travels in the job payload, and let `JobsService.enqueue`
 * own admission, the credit hold and BullMQ. Unlike a transcript, the
 * `audio_cleans` row **is** created here rather than left to the completion —
 * a clean run is additive (a project can hold several, brief §1: undo, A/B)
 * so there is no "one live draft" for an orphaned row to collide with, and the
 * list endpoint needs something to show while a job is still queued.
 */
@Injectable()
export class AudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  async requestClean(input: RequestCleanInput): Promise<RequestCleanResult> {
    const project = await this.project(input.projectId, input.workspaceId);
    const media = await this.media(project.id, input.mediaId);

    const quote = quoteAudioClean(media.durationMs ?? 0);
    const cleanId = newId();
    const jobKey = `clean:${project.id}:${media.id}:${input.strength}:${input.target}`;

    await this.prisma.audioClean.create({
      data: {
        id: cleanId,
        projectId: project.id,
        mediaId: media.id,
        strength: input.strength,
        target: input.target,
        dereverb: input.dereverb ?? false,
        deesser: input.deesser ?? false,
        status: "queued",
        createdBy: input.userId,
      },
    });

    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.clean",
      workspaceId: input.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        cleanId,
        mediaId: media.id,
        durationMs: media.durationMs,
        strength: input.strength,
        target: input.target,
        dereverb: input.dereverb ?? false,
        deesser: input.deesser ?? false,
      },
    });

    if (deduplicated) {
      // Another live run for this exact (media, strength, target) already owns
      // the job; the row this call just inserted has no worker behind it, so it
      // is removed rather than left to sit at `queued` forever.
      await this.prisma.audioClean.delete({ where: { id: cleanId } }).catch(() => undefined);
    } else {
      await this.prisma.audioClean.update({ where: { id: cleanId }, data: { jobId: job.id } });
    }
    return { jobId: job.id, cleanId, status: "queued", deduplicated, quote };
  }

  async list(input: {
    projectId: string;
    workspaceId: string;
    mediaId?: string;
  }): Promise<AudioCleanView[]> {
    const project = await this.project(input.projectId, input.workspaceId);
    const rows = await this.prisma.audioClean.findMany({
      where: {
        projectId: project.id,
        ...(input.mediaId === undefined ? {} : { mediaId: input.mediaId }),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const reconciled = await Promise.all(rows.map((row) => this.reconcile(row)));
    return Promise.all(reconciled.map((row) => this.toView(row)));
  }

  /**
   * A completion handler only runs on *success* (`JobsService.runCompletionHandler`
   * is called only when `succeeded`), so a failed or dead-lettered `ai.clean`
   * leaves nothing to flip this row off `queued`/`running` on its own. Reads
   * are the cheap place to notice: a row still open whose job has since failed
   * gets its status and failure reason copied over, once, before it is shown.
   */
  private async reconcile(row: AudioClean): Promise<AudioClean> {
    if (row.status !== "queued" && row.status !== "running") return row;
    if (row.jobId === null) return row;
    const job = await this.prisma.job.findUnique({ where: { id: row.jobId } });
    if (job === null) return row;
    if (job.status === "failed" || job.status === "cancelled") {
      const error = job.error as { message?: unknown } | null;
      const reason = typeof error?.message === "string" ? error.message : job.status;
      return this.prisma.audioClean.update({
        where: { id: row.id },
        data: { status: "failed", failureReason: reason },
      });
    }
    if (job.status === "running" && row.status !== "running") {
      return this.prisma.audioClean.update({ where: { id: row.id }, data: { status: "running" } });
    }
    return row;
  }

  private async toView(row: AudioClean): Promise<AudioCleanView> {
    const keys = (row.storageKeys ?? {}) as Record<string, unknown>;
    const signed = async (key: unknown): Promise<string | undefined> => {
      if (typeof key !== "string" || key === "") return undefined;
      return this.derived.presignGet(key, SIGNED_URL_TTL_S);
    };
    return {
      id: row.id,
      projectId: row.projectId,
      mediaId: row.mediaId,
      strength: row.strength,
      target: row.target,
      dereverb: row.dereverb,
      deesser: row.deesser,
      status: row.status,
      jobId: row.jobId,
      metrics: (row.metrics as Record<string, unknown> | null) ?? undefined,
      cleanedAudioUrl: await signed(keys["cleanedAudioUrl"]),
      previewOriginalUrl: await signed(keys["previewOriginalUrl"]),
      previewCleanedUrl: await signed(keys["previewCleanedUrl"]),
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString(),
    };
  }

  private async project(projectId: string, workspaceId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    return project;
  }

  /** The named media, or the project's primary media when none is named. */
  private async media(projectId: string, mediaId?: string): Promise<MediaAsset> {
    const media = mediaId
      ? await this.prisma.mediaAsset.findFirst({ where: { id: mediaId, projectId } })
      : await this.prisma.mediaAsset.findFirst({
          where: { projectId, role: "primary" },
          orderBy: { createdAt: "desc" },
        });
    if (media === null) {
      throw new AppException(
        AUDIO_ERROR_CODES.mediaNotReady,
        "This project has no media to clean.",
        HttpStatus.CONFLICT,
        { projectId },
      );
    }
    if (media.status !== "ready" || media.audio48kKey === null || media.durationMs === null) {
      throw new AppException(
        AUDIO_ERROR_CODES.mediaNotReady,
        "The media has no 48 kHz derived audio yet.",
        HttpStatus.CONFLICT,
        { mediaId: media.id, status: media.status },
      );
    }
    return media;
  }
}
