import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { newId } from "@montaj/edg";
import { editPlanTemplate, validateEditPlan } from "@montaj/prompts";
import type { EditPlanInput, EditPlanOutput, EditPlanPlanTier } from "@montaj/prompts";

import { PLANNER_CLIENT } from "./planner-client.js";
import { PROMPTED_EDIT_CHAIN_ORDER, PROMPTED_EDIT_ERROR_CODES } from "./prompted-edits.errors.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgService } from "../edg/index.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";
import { quotePromptedEdit } from "../passes/passes.quote.js";
import { PassesService } from "../passes/passes.service.js";
import { paramsFor, startChainKind } from "../passes/prompted-chain.js";
import { TranscriptsRepository } from "../transcripts/transcripts.repository.js";

import type { PlannerClient } from "./planner-client.js";
import type { MediaAsset, PromptedEditPlan, Project, Transcript } from "@prisma/client";

/**
 * The prompted-edits producer (D07, 09-ai-pipeline section 6): plan, then run.
 *
 * `plan()` builds an EditPlanInput from the project's own facts (duration,
 * language, existing styles, the workspace's plan tier), calls
 * PlannerClient, re-checks the result against validateEditPlan
 * (schema validity alone is not enough -- an LLM can emit a schema-valid but
 * out-of-budget or wrong-engine-tier plan) and stores it, status "planned",
 * for the plan preview sheet to show before anything runs.
 *
 * `run()` holds credits on the plan's source duration (CONTRACTS section 4
 * worstCaseHoldTenths) and starts the first pass of the plan's
 * dependency-ordered chain (PROMPTED_EDIT_CHAIN_ORDER); PromptedChainAdvancer
 * (../passes/prompted-chain.ts) steps the rest from each ai.pass
 * completion and settles the hold on the finished duration once the chain
 * lands.
 */
export interface CreatePlanInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly engine: "flash" | "pro";
}

export interface RunPlanResult {
  readonly planId: string;
  readonly jobId: string;
  readonly firstPassKind: string;
  readonly status: string;
  readonly holdTenths: number;
  readonly holdCredits: string;
}

@Injectable()
export class PromptedEditsService {
  private readonly logger = new Logger(PromptedEditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transcripts: TranscriptsRepository,
    private readonly edg: EdgService,
    private readonly passes: PassesService,
    @Inject(PLANNER_CLIENT) private readonly planner: PlannerClient,
  ) {}

  async plan(input: CreatePlanInput): Promise<PromptedEditPlan> {
    const project = await this.project(input.projectId, input.workspaceId);
    const media = await this.primaryMedia(project.id);
    const transcript = await this.latestTranscript(project.id);
    const planTier = (await resolveWorkspacePlan(
      this.prisma,
      input.workspaceId,
    )) as EditPlanPlanTier;
    const existingStyles = await this.existingStylesOf(project.id, input.workspaceId);

    const editPlanInput: EditPlanInput = editPlanTemplate.inputSchema.parse({
      prompt: input.prompt,
      language: transcript?.language ?? "en",
      mediaTitle: project.title,
      durationMs: media.durationMs ?? 0,
      existingStyles,
      planTier,
      segments: transcript === null ? [] : await this.segmentsOf(transcript),
    });

    const generated = await this.planner.generate(editPlanInput);
    const violations = validateEditPlan(generated.output, { planTier, existingStyles });
    if (violations.length > 0) {
      throw new AppException(
        PROMPTED_EDIT_ERROR_CODES.guardrailViolation,
        "The generated plan failed a guardrail check.",
        HttpStatus.UNPROCESSABLE_ENTITY,
        { violations },
      );
    }

    const quote = quotePromptedEdit(media.durationMs ?? 0, media.durationMs ?? 0, input.engine);
    const row = await this.prisma.promptedEditPlan.create({
      data: {
        id: newId(),
        projectId: project.id,
        workspaceId: input.workspaceId,
        prompt: input.prompt,
        engine: input.engine,
        planTier,
        plan: generated.output as unknown as object,
        provider: generated.provider,
        templateVersion: generated.templateVersion,
        status: "planned",
        sourceDurationMs: media.durationMs ?? 0,
        holdTenths: quote.holdTenths,
      },
    });

    this.logger.log(
      { projectId: project.id, planId: row.id, passes: generated.output.passes.length },
      "prompted-edit plan created",
    );
    return row;
  }

  async get(projectId: string, workspaceId: string, planId: string): Promise<PromptedEditPlan> {
    await this.project(projectId, workspaceId);
    return this.findPlan(projectId, workspaceId, planId);
  }

  async run(projectId: string, workspaceId: string, planId: string): Promise<RunPlanResult> {
    await this.project(projectId, workspaceId);
    const row = await this.findPlan(projectId, workspaceId, planId);
    if (row.status !== "planned") {
      throw new AppException(
        PROMPTED_EDIT_ERROR_CODES.invalidStatus,
        `This plan is "${row.status}", not "planned".`,
        HttpStatus.CONFLICT,
        { planId, status: row.status },
      );
    }

    const output = row.plan as unknown as EditPlanOutput;
    const orderedKinds = PROMPTED_EDIT_CHAIN_ORDER.filter((kind) =>
      output.passes.some((pass) => pass.kind === kind),
    );
    const [first, ...rest] = orderedKinds;
    if (first === undefined) {
      throw new AppException(
        PROMPTED_EDIT_ERROR_CODES.guardrailViolation,
        "This plan has no passes to run.",
        HttpStatus.UNPROCESSABLE_ENTITY,
        { planId },
      );
    }

    const finishedDurationMs = await this.passes.finishedDurationMs(projectId, workspaceId);
    const tier = row.engine === "pro" ? "pro" : "flash";
    const quote = quotePromptedEdit(row.sourceDurationMs, finishedDurationMs, tier);

    // `CreditHold.jobId` is a real, unique foreign key into `jobs` (schema.prisma)
    // -- `CreditsFacade.reserve` cannot hold against a synthetic id, and cannot
    // be called twice for the same job. So the macro hold is minted by
    // `JobsService.enqueue`'s own `reserve()` call for the chain's first job,
    // via `costOverrideTenths` (`startChainKind`'s doc comment), rather than a
    // second explicit `reserve()` here.
    const params = paramsFor(row.plan, first);
    const started = await startChainKind(
      this.passes,
      first,
      projectId,
      workspaceId,
      params,
      quote.holdTenths,
    );
    const startedJob = await this.prisma.job.findUniqueOrThrow({ where: { id: started.jobId } });

    await this.prisma.promptedEditPlan.update({
      where: { id: row.id },
      data: {
        status: "running",
        holdId: startedJob.creditHoldId,
        holdTenths: quote.holdTenths,
        currentJobId: started.jobId,
        remainingKinds: rest,
      },
    });

    this.logger.log(
      { planId: row.id, jobId: started.jobId, firstPassKind: first, holdTenths: quote.holdTenths },
      "prompted-edit plan run started",
    );

    return {
      planId: row.id,
      jobId: started.jobId,
      firstPassKind: first,
      status: "running",
      holdTenths: quote.holdTenths,
      holdCredits: quote.holdCredits,
    };
  }

  // -------------------------------------------------------------------------

  private async project(projectId: string, workspaceId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    return project;
  }

  private async findPlan(
    projectId: string,
    workspaceId: string,
    planId: string,
  ): Promise<PromptedEditPlan> {
    const row = await this.prisma.promptedEditPlan.findFirst({
      where: { id: planId, projectId, workspaceId },
    });
    if (row === null) {
      throw new AppException(
        PROMPTED_EDIT_ERROR_CODES.planNotFound,
        "No such prompted-edit plan.",
        HttpStatus.NOT_FOUND,
        { planId },
      );
    }
    return row;
  }

  private async primaryMedia(projectId: string): Promise<MediaAsset> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });
    if (
      media === null ||
      media.status !== "ready" ||
      media.durationMs === null ||
      media.durationMs <= 0
    ) {
      throw new AppException(
        PROMPTED_EDIT_ERROR_CODES.mediaNotReady,
        "This project's media is not ready for a prompted edit.",
        HttpStatus.CONFLICT,
        { projectId },
      );
    }
    return media;
  }

  private async latestTranscript(projectId: string): Promise<Transcript | null> {
    return this.prisma.transcript.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  /** One {startMs,endMs,text,speaker?} row per chunk -- same shape insights.service.ts builds. */
  private async segmentsOf(
    transcript: Transcript,
  ): Promise<{ startMs: number; endMs: number; text: string; speaker?: string }[]> {
    const rows = await this.transcripts.allChunks(transcript.id, transcript.currentRevision);
    const segments: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];
    for (const row of rows) {
      const words = (
        row.words as unknown as { t: string; sp?: string; deleted?: boolean }[]
      ).filter((word) => word.deleted !== true);
      const text = words
        .map((word) => word.t)
        .join(" ")
        .trim();
      if (text === "") continue;
      const speaker = words.find((word) => word.sp !== undefined)?.sp;
      segments.push({
        startMs: row.startMs,
        endMs: row.endMs,
        text,
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
    return segments;
  }

  /**
   * styleRefs already on the project: the live document's defaultStyleId
   * plus every distinct Segment.styleRef -- the closed set validateEditPlan
   * checks a plan's style field against.
   */
  private async existingStylesOf(projectId: string, workspaceId: string): Promise<string[]> {
    const styles = new Set<string>();
    try {
      const { hot } = await this.edg.document(projectId, workspaceId);
      if (hot.styles.defaultStyleId !== "") styles.add(hot.styles.defaultStyleId);
    } catch {
      return []; // edg/not_initialised: no live document yet, no styles.
    }
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await this.edg.segments(projectId, workspaceId, cursor, 1_000);
      } catch {
        return [...styles];
      }
      for (const segment of page.segments) {
        if (segment.styleRef !== undefined) styles.add(segment.styleRef);
      }
      if (page.nextCursor === null) return [...styles];
      cursor = page.nextCursor;
    }
  }
}
