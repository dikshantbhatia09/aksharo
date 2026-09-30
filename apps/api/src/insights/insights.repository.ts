import { Injectable } from "@nestjs/common";

import { newId } from "@montaj/edg";
import type { InsightKind } from "@montaj/prompts";

import { PrismaService } from "../common/prisma/prisma.service.js";

import type { LlmOutput, Prisma } from "@prisma/client";

/**
 * What an `llm_outputs` row holds: an insight kind, or `episode-pack`, the text
 * a clips run writes for its source video (2026-09-29), or `broll`, the moments
 * in one clip a picture could cut away at (2026-10-05, on the clip's project).
 */
export type LlmOutputKind = InsightKind | "episode-pack" | "broll";

export interface CreateLlmOutputInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly jobId: string | null;
  readonly kind: LlmOutputKind;
  readonly templateVersion: string;
  readonly provider: string;
  readonly region: string;
  readonly output: Prisma.InputJsonValue;
  readonly usage: Prisma.InputJsonValue;
}

/** `llm_outputs` (B11): every `ai.llm` completion, newest first per kind. */
@Injectable()
export class InsightsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateLlmOutputInput): Promise<LlmOutput> {
    return this.prisma.llmOutput.create({
      data: {
        id: newId(),
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        kind: input.kind,
        templateVersion: input.templateVersion,
        provider: input.provider,
        region: input.region,
        output: input.output,
        usage: input.usage,
      },
    });
  }

  /** The project's newest row of one kind, or null. */
  async latestOfKind(projectId: string, kind: LlmOutputKind): Promise<LlmOutput | null> {
    return this.prisma.llmOutput.findFirst({
      where: { projectId, kind },
      orderBy: { createdAt: "desc" },
    });
  }

  /** The most recent row per kind for the project (`GET /projects/{id}/insights`). */
  async latestPerKind(projectId: string): Promise<LlmOutput[]> {
    const rows = await this.prisma.llmOutput.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    const seen = new Set<string>();
    const latest: LlmOutput[] = [];
    for (const row of rows) {
      if (seen.has(row.kind)) continue;
      seen.add(row.kind);
      latest.push(row);
    }
    return latest;
  }
}
