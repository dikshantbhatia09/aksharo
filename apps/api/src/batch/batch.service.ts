import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { formatCredits } from "@montaj/config";

import { BATCH_ERRORS } from "./batch.constants.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import {
  ProjectsService,
  type ProjectView,
  CreateProjectInput,
} from "../projects/projects.service.js";
import { quoteTranscription } from "../transcripts/transcripts.quote.js";
import { TranscriptsService } from "../transcripts/transcripts.service.js";

import type { ApplyBatchDto, BatchSettings, CreateBatchDto } from "./batch.dto.js";

export interface BatchQuote {
  readonly perItemTenths: readonly number[];
  readonly totalTenths: number;
  readonly totalCredits: string;
}

export interface BatchProjectStatus {
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly latestJobStatus: string | null;
  readonly latestJobType: string | null;
  readonly latestJobError: string | null;
}

export interface BatchView {
  readonly id: string;
  readonly workspaceId: string;
  readonly settings: BatchSettings;
  readonly creditsQuoted: string;
  readonly createdAt: string;
  readonly projects: readonly BatchProjectStatus[];
}

/**
 * Batch orchestration (B15 brief §4): "Apply to all" settings, an up-front
 * credit quote/confirm, creating N projects tagged with a `batch_id`, and a
 * progress view.
 *
 * Project *rows* are created by `ProjectsService.batchCreate` (A06's stub,
 * built exactly for this) — this service does not duplicate that transaction,
 * it tags the resulting rows with the new batch and drives the "enqueue per
 * project" half A06 left for later. Enqueuing reuses `TranscriptsService.
 * transcribe()` unchanged: a project without a probed media asset yet simply
 * reports `transcript/media_not_ready` in its per-project status rather than
 * failing the whole batch, since batch upload and batch enqueue are two
 * separate calls from the web dropzone (A14 uploads each file to its project
 * between them).
 */
@Injectable()
export class BatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly transcripts: TranscriptsService,
    private readonly audit: CommonAuditService,
  ) {}

  /** Up-front quote, before any project exists (brief §4: "quoted... with a confirm step"). */
  quote(durationsMs: readonly number[]): BatchQuote {
    const perItemTenths = durationsMs.map((durationMs) => quoteTranscription(durationMs).tenths);
    const totalTenths = perItemTenths.reduce((sum, tenths) => sum + tenths, 0);
    return { perItemTenths, totalTenths, totalCredits: formatCredits(totalTenths) };
  }

  async create(workspaceId: string, userId: string, input: CreateBatchDto): Promise<BatchView> {
    if (input.projects.length === 0) {
      throw new AppException(
        BATCH_ERRORS.empty,
        "A batch needs at least one project.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const quote =
      input.durationsMs === undefined || input.durationsMs.length === 0
        ? undefined
        : this.quote(input.durationsMs);

    const batch = await this.prisma.batch.create({
      data: {
        id: ulid(),
        workspaceId,
        createdBy: userId,
        settings: (input.settings ?? {}) as object,
        creditsQuotedTenths: quote?.totalTenths ?? 0,
      },
    });

    const created = await this.projects.batchCreate(workspaceId, userId, {
      projects: input.projects as CreateProjectInput[],
      folderId: input.folderId,
      clientTag: input.clientTag,
    });

    await this.prisma.project.updateMany({
      where: { id: { in: created.map((project) => project.id) } },
      data: { batchId: batch.id },
    });

    await this.audit.record({
      action: "batch.created",
      resource: "batch",
      resourceId: batch.id,
      actorId: userId,
      workspaceId,
      data: { projectCount: created.length, creditsQuotedTenths: batch.creditsQuotedTenths },
    });

    return this.view(workspaceId, batch.id, created);
  }

  /**
   * "one-click export-all" starts here for the *ingest* half: enqueue
   * transcription for every project in the batch that already has a probed
   * primary media asset. A project still waiting on its upload is skipped, not
   * failed — its status simply stays `transcript/media_not_ready` until the
   * caller applies again.
   */
  async apply(
    workspaceId: string,
    userId: string,
    batchId: string,
    override: ApplyBatchDto,
  ): Promise<BatchView> {
    const batch = await this.prisma.batch.findFirst({ where: { id: batchId, workspaceId } });
    if (batch === null) {
      throw new AppException(BATCH_ERRORS.notFound, "Batch not found.", HttpStatus.NOT_FOUND);
    }

    const settings = { ...(batch.settings as BatchSettings), ...override.settings };
    const projects = await this.prisma.project.findMany({
      where: { batchId, deletedAt: null },
      select: { id: true },
    });

    await Promise.all(
      projects.map(async ({ id: projectId }) => {
        try {
          await this.transcripts.transcribe({
            projectId,
            workspaceId,
            userId,
            languages: settings.languages,
          });
        } catch {
          // Per-project failure (no media yet, insufficient credits, ...) is
          // reported through the progress view, not by failing the whole batch.
        }
      }),
    );

    return this.view(workspaceId, batchId);
  }

  async get(workspaceId: string, batchId: string): Promise<BatchView> {
    const batch = await this.prisma.batch.findFirst({ where: { id: batchId, workspaceId } });
    if (batch === null) {
      throw new AppException(BATCH_ERRORS.notFound, "Batch not found.", HttpStatus.NOT_FOUND);
    }
    return this.view(workspaceId, batchId);
  }

  private async view(
    workspaceId: string,
    batchId: string,
    createdProjects?: readonly ProjectView[],
  ): Promise<BatchView> {
    const batch = await this.prisma.batch.findFirstOrThrow({ where: { id: batchId, workspaceId } });
    const projects = await this.prisma.project.findMany({
      where: { batchId, deletedAt: null },
      include: { jobs: { orderBy: { queuedAt: "desc" }, take: 1 } },
    });

    const statuses: BatchProjectStatus[] = projects.map((project) => {
      const latestJob = project.jobs[0];
      return {
        projectId: project.id,
        title: project.title,
        status: project.status,
        latestJobStatus: latestJob?.status ?? null,
        latestJobType: latestJob?.type ?? null,
        latestJobError:
          latestJob?.error === null || latestJob?.error === undefined
            ? null
            : JSON.stringify(latestJob.error),
      };
    });

    // Freshly created projects may not have committed their `jobs` relation
    // read yet in the same request; fall back to the plain view passed in.
    const byId = new Map(statuses.map((status) => [status.projectId, status] as const));
    for (const project of createdProjects ?? []) {
      if (!byId.has(project.id)) {
        statuses.push({
          projectId: project.id,
          title: project.title,
          status: project.status,
          latestJobStatus: null,
          latestJobType: null,
          latestJobError: null,
        });
      }
    }

    return {
      id: batch.id,
      workspaceId: batch.workspaceId,
      settings: batch.settings as BatchSettings,
      creditsQuoted: formatCredits(batch.creditsQuotedTenths),
      createdAt: batch.createdAt.toISOString(),
      projects: statuses,
    };
  }
}
