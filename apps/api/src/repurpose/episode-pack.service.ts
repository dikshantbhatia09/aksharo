import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import { discoveryModelOptions } from "./highlights-options.js";
import { REPURPOSE_ERRORS, REPURPOSE_FLAGS } from "./repurpose.constants.js";
import { RepurposeService, discoveryLanguage } from "./repurpose.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { InsightsRepository } from "../insights/insights.repository.js";
import { INSIGHTS_DISCLOSURE, InsightsService } from "../insights/insights.service.js";

import type { RepurposeRun } from "@prisma/client";

/**
 * The episode text pack of a clips run (2026-09-29): what a creator posts with
 * the whole video, beside its clips. Chapters, a YouTube description, show
 * notes, a LinkedIn post, an X thread and a newsletter draft, written by the
 * worker (`ai.llm` kind `episode-pack`, `worker_ai/llm/episode_pack.py`) from
 * the run's SOURCE project, in the run's language and script (the same rules
 * as a clip's copy), and stored as that project's `llm_outputs` row.
 *
 * Part of the run: it costs the person nothing, and never holds up or fails
 * the run. An Autopilot run asks for it once its moments are found; any run's
 * page can ask for it (or ask again after a failure). One pack per source
 * video: once written, it is not written again.
 */
export const EPISODE_PACK_KIND = "episode-pack";

export type EpisodePackStatus = "none" | "writing" | "ready" | "failed";

const EpisodePackSchema = z.object({
  chapters: z
    .array(z.object({ startMs: z.number().int().nonnegative(), title: z.string() }))
    .max(50),
  youtubeDescription: z.string(),
  showNotes: z.string(),
  linkedinPost: z.string(),
  xThread: z.array(z.string()).max(20),
  newsletter: z.string(),
  locale: z.string().default(""),
  source: z.enum(["model", "heuristic", "mixed"]).default("heuristic"),
});

export type EpisodePack = z.infer<typeof EpisodePackSchema>;

export interface EpisodePackView {
  readonly runId: string;
  readonly status: EpisodePackStatus;
  readonly pack: EpisodePack | null;
  /** When the pack was written; null until it is. */
  readonly createdAt: string | null;
  /** The label shown with anything generated (the insights one). */
  readonly disclosure: string;
}

/** Every episode-pack job of a source project starts with this. */
export function episodePackJobPrefix(projectId: string): string {
  return `ai.llm:${EPISODE_PACK_KIND}:${projectId}:`;
}

const LIVE = new Set(["queued", "running"]);

@Injectable()
export class RepurposeEpisodePackService {
  private readonly logger = new Logger(RepurposeEpisodePackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly insights: InsightsService,
    private readonly outputs: InsightsRepository,
  ) {}

  /** `GET /repurpose/runs/{runId}/episode-pack`. */
  async view(workspaceId: string, runId: string): Promise<EpisodePackView> {
    return this.viewOf(await this.require(workspaceId, runId));
  }

  /**
   * `POST /repurpose/runs/{runId}/episode-pack`: write it now, when it is
   * neither written nor being written. A failed one is written again.
   */
  async write(workspaceId: string, runId: string): Promise<EpisodePackView> {
    const run = await this.require(workspaceId, runId);
    await this.start(run, { again: true });
    return this.viewOf(run);
  }

  /**
   * Start the pack for `run` once: the Autopilot trigger (after its moments
   * are found). Never throws: the pack must not fail what asked for it.
   */
  async ensure(run: RepurposeRun): Promise<void> {
    try {
      await this.start(run, { again: false });
    } catch (error) {
      this.logger.warn({ runId: run.id, err: error }, "could not start the episode text");
    }
  }

  private async start(run: RepurposeRun, options: { readonly again: boolean }): Promise<void> {
    const current = await this.statusOf(run);
    if (current.status === "ready" || current.status === "writing") return;
    if (current.status === "failed" && !options.again) return;

    const transcript = await this.prisma.transcript.findFirst({
      where: { projectId: run.sourceProjectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, currentRevision: true, language: true },
    });
    // Nothing to write from yet: the page asks again once there is.
    if (transcript === null) return;

    const config =
      typeof run.config === "object" && run.config !== null && !Array.isArray(run.config)
        ? (run.config as Record<string, unknown>)
        : {};
    const language = discoveryLanguage(transcript.language, config["sourceLanguage"]);
    const { copy } = discoveryModelOptions(run.config, language, null);
    await this.insights.requestEpisodePack({
      projectId: run.sourceProjectId,
      workspaceId: run.workspaceId,
      jobKey: `${episodePackJobPrefix(run.sourceProjectId)}${transcript.id}:${String(transcript.currentRevision)}`,
      copy: copy ?? { language, scriptMode: "auto" },
    });
  }

  private async viewOf(run: RepurposeRun): Promise<EpisodePackView> {
    const { status, pack, createdAt } = await this.statusOf(run);
    return {
      runId: run.id,
      status,
      pack,
      createdAt,
      disclosure: INSIGHTS_DISCLOSURE,
    };
  }

  private async statusOf(run: RepurposeRun): Promise<{
    readonly status: EpisodePackStatus;
    readonly pack: EpisodePack | null;
    readonly createdAt: string | null;
  }> {
    const row = await this.outputs.latestOfKind(run.sourceProjectId, EPISODE_PACK_KIND);
    if (row !== null) {
      const parsed = EpisodePackSchema.safeParse(row.output);
      if (parsed.success) {
        return { status: "ready", pack: parsed.data, createdAt: row.createdAt.toISOString() };
      }
      this.logger.warn({ runId: run.id, outputId: row.id }, "an episode pack that does not parse");
    }
    const job = await this.prisma.job.findFirst({
      where: {
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        type: "ai.llm",
        jobKey: { startsWith: episodePackJobPrefix(run.sourceProjectId) },
      },
      orderBy: { id: "desc" },
      select: { status: true },
    });
    if (job !== null && LIVE.has(job.status)) {
      return { status: "writing", pack: null, createdAt: null };
    }
    // A job that ended without a row (or a row that does not parse) failed.
    if (job !== null || row !== null) return { status: "failed", pack: null, createdAt: null };
    return { status: "none", pack: null, createdAt: null };
  }

  private async require(workspaceId: string, runId: string): Promise<RepurposeRun> {
    if (!(await this.runs.flagEnabled(workspaceId, REPURPOSE_FLAGS.flow))) {
      throw new AppException(
        REPURPOSE_ERRORS.disabled,
        "This feature is not available yet.",
        HttpStatus.NOT_FOUND,
      );
    }
    const run = await this.prisma.repurposeRun.findFirst({ where: { id: runId, workspaceId } });
    if (run === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
    return run;
  }
}
