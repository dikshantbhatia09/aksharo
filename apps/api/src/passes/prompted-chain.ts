/**
 * Chain advance for a prompted-edit plan (D07 §3): what happens after one
 * `ai.pass` job of a plan's chain lands.
 *
 * Lives in `apps/api/src/passes/**` (this work package's "chain hooks"
 * boundary) rather than `apps/api/src/prompted-edits/**`, so
 * `PassCompletionHandler` — the sole registered owner of the `ai.pass` queue
 * (`JobCompletionRegistry` allows exactly one handler per queue) — can call it
 * directly without `PassesModule` importing `PromptedEditsModule` (which
 * itself imports `PassesModule` for `PassesService`; avoiding that cycle is
 * the whole reason this file exists here instead of over there).
 *
 * The chain is tracked entirely on the `prompted_edit_plans` row
 * (`currentJobId`, `remainingKinds`) rather than inside the `ai.pass` job
 * payload itself — the payload is exactly what `apps/worker-ai` expects for
 * that pass kind (CONTRACTS §3) and is not a place to smuggle orchestration
 * metadata through a Python worker that has no reason to understand it.
 * `onPassCompleted` looks a landed job up by `currentJobId`; a job that is not
 * the live step of any `running` plan (the overwhelming majority — a manual
 * pass from the Passes tab) is a no-op, one indexed lookup.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import { quotePromptedEdit } from "./passes.quote.js";
import { PassesService } from "./passes.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { CREDITS_FACADE } from "../credits/credits.facade.js";
import { PROMPTED_EDIT_CHAIN_ORDER } from "../prompted-edits/prompted-edits.errors.js";

import type { CreditsFacade } from "../credits/credits.facade.js";
import type { Job, Prisma } from "@prisma/client";

export type ChainPassKind = (typeof PROMPTED_EDIT_CHAIN_ORDER)[number];

export interface StartedPass {
  readonly jobId: string;
}

@Injectable()
export class PromptedChainAdvancer {
  private readonly logger = new Logger(PromptedChainAdvancer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passes: PassesService,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
  ) {}

  /** Called from `PassCompletionHandler.handle()` after a successful `ai.pass` completion. */
  async onPassCompleted(job: Job): Promise<void> {
    const plan = await this.prisma.promptedEditPlan.findFirst({
      where: { currentJobId: job.id, status: "running" },
    });
    if (plan === null) return;

    const remaining = [...plan.remainingKinds] as ChainPassKind[];
    const next = remaining.shift();

    if (next === undefined) {
      await this.settle(plan.id, plan.projectId, plan.workspaceId, plan.engine, plan.sourceDurationMs, plan.holdId);
      return;
    }

    try {
      const paramsForKind = paramsFor(plan.plan, next);
      const started = await this.startKind(next, plan.projectId, plan.workspaceId, paramsForKind);
      await this.prisma.promptedEditPlan.update({
        where: { id: plan.id },
        data: { currentJobId: started.jobId, remainingKinds: remaining },
      });
      this.logger.log(
        { planId: plan.id, kind: next, jobId: started.jobId },
        "prompted-edit chain advanced",
      );
    } catch (error) {
      this.logger.error({ planId: plan.id, kind: next, error }, "prompted-edit chain step failed");
      await this.fail(plan.id, plan.holdId);
    }
  }

  /** Called from `PassCompletionHandler.handleFailure()`. */
  async onPassFailed(job: Job): Promise<void> {
    const plan = await this.prisma.promptedEditPlan.findFirst({
      where: { currentJobId: job.id, status: "running" },
    });
    if (plan === null) return;
    await this.fail(plan.id, plan.holdId);
  }

  private async settle(
    planId: string,
    projectId: string,
    workspaceId: string,
    engine: string,
    sourceDurationMs: number,
    holdId: string | null,
  ): Promise<void> {
    const finishedDurationMs = await this.passes.finishedDurationMs(projectId, workspaceId);
    const tier = engine === "pro" ? "pro" : "flash";
    const quote = quotePromptedEdit(sourceDurationMs, finishedDurationMs, tier);
    let settledTenths = quote.costTenths;
    if (holdId !== null) {
      const result = await this.credits.settle({ holdId, actualTenths: quote.costTenths });
      settledTenths = result.settledTenths;
    }
    await this.prisma.promptedEditPlan.update({
      where: { id: planId },
      data: { status: "completed", currentJobId: null, settledTenths },
    });
    this.logger.log({ planId, settledTenths }, "prompted-edit plan completed");
  }

  private async fail(planId: string, holdId: string | null): Promise<void> {
    if (holdId !== null) {
      await this.credits.release({ holdId }).catch(() => undefined);
    }
    await this.prisma.promptedEditPlan.update({
      where: { id: planId },
      data: { status: "failed", currentJobId: null },
    });
  }

  private async startKind(
    kind: ChainPassKind,
    projectId: string,
    workspaceId: string,
    params: Record<string, unknown>,
  ): Promise<StartedPass> {
    return startChainKind(this.passes, kind, projectId, workspaceId, params);
  }
}

/**
 * Start one chain-internal pass (`skipCredits: true` — its cost is already
 * covered by the plan's own macro hold, see `passes.service.ts`'s
 * `skipCredits` doc comment). Exported standalone so both
 * {@link PromptedChainAdvancer} (stepping the chain from job to job) and
 * `PromptedEditsService.run` (kicking off the first step) share exactly one
 * mapping from a plan's per-kind params to a `PassesService.start*` call.
 */
export async function startChainKind(
  passes: PassesService,
  kind: ChainPassKind,
  projectId: string,
  workspaceId: string,
  params: Record<string, unknown>,
): Promise<StartedPass> {
  switch (kind) {
    case "autocut":
      return passes.startAutocut({
        projectId,
        workspaceId,
        preset: (params["preset"] as "gentle" | "standard" | "tight" | undefined) ?? "standard",
        skipCredits: true,
      });
    case "zoom":
      return passes.startZoom({
        projectId,
        workspaceId,
        preset: (params["preset"] as "subtle" | "standard" | "punchy" | undefined) ?? "standard",
        skipCredits: true,
      });
    case "reframe":
      return passes.startReframe({
        projectId,
        workspaceId,
        aspect: (params["aspect"] as "9:16" | "1:1" | undefined) ?? "9:16",
        skipCredits: true,
      });
    case "sfx":
      return passes.startSfx({ projectId, workspaceId, skipCredits: true });
    case "music":
      return passes.startMusic({ projectId, workspaceId, skipCredits: true });
    case "textfx":
      return passes.startTextFx({ projectId, workspaceId, skipCredits: true });
    default: {
      const exhaustive: never = kind;
      throw new Error(`no chain starter for pass kind ${String(exhaustive)}`);
    }
  }
}

export function paramsFor(plan: Prisma.JsonValue, kind: ChainPassKind): Record<string, unknown> {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return {};
  const passes = (plan as { passes?: unknown }).passes;
  if (!Array.isArray(passes)) return {};
  const match = passes.find(
    (p): p is { kind: string; params?: Record<string, unknown> } =>
      typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === kind,
  );
  return match?.params ?? {};
}
