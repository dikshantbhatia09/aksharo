import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EditPlanOutput } from "@montaj/prompts";

import { PromptedEditsService } from "./prompted-edits.service.js";
import { AppException } from "../common/errors/error-codes.js";

import type { PlannerClient } from "./planner-client.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { EdgService } from "../edg/index.js";
import type { PassesService } from "../passes/passes.service.js";
import type { TranscriptsRepository } from "../transcripts/transcripts.repository.js";

const PROJECT_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VC";
const WORKSPACE_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VB";
const PLAN_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VD";
const MEDIA_DURATION_MS = 90_000;

/**
 * Two known-good passes in dependency order, matching D07's chain
 * (autocut before music) -- enough to exercise `run()`'s ordering logic
 * without depending on the real `mockEditPlan`.
 */
function twoPassOutput(): EditPlanOutput {
  return {
    passes: [
      { kind: "autocut", params: { preset: "standard", engine: "flash" } },
      { kind: "music", params: { engine: "flash" } },
    ],
    rationale: ["cuts the boring parts", "adds background music"],
  };
}

interface Deps {
  service: PromptedEditsService;
  prisma: {
    project: { findFirst: ReturnType<typeof vi.fn> };
    mediaAsset: { findFirst: ReturnType<typeof vi.fn> };
    transcript: { findFirst: ReturnType<typeof vi.fn> };
    promptedEditPlan: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    job: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
    subscription: { findFirst: ReturnType<typeof vi.fn> };
  };
  passes: {
    finishedDurationMs: ReturnType<typeof vi.fn>;
    startAutocut: ReturnType<typeof vi.fn>;
    startZoom: ReturnType<typeof vi.fn>;
    startReframe: ReturnType<typeof vi.fn>;
    startSfx: ReturnType<typeof vi.fn>;
    startMusic: ReturnType<typeof vi.fn>;
    startTextFx: ReturnType<typeof vi.fn>;
  };
  planner: { generate: ReturnType<typeof vi.fn> };
  edg: { document: ReturnType<typeof vi.fn>; segments: ReturnType<typeof vi.fn> };
}

function buildService(overrides?: {
  plannerOutput?: EditPlanOutput;
  planTier?: string;
}): Deps {
  const plannerOutput = overrides?.plannerOutput ?? twoPassOutput();

  const prisma = {
    project: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, title: "My Video" }),
    },
    mediaAsset: {
      findFirst: vi.fn().mockResolvedValue({
        id: "media1",
        status: "ready",
        durationMs: MEDIA_DURATION_MS,
      }),
    },
    transcript: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    promptedEditPlan: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data, createdAt: new Date(), updatedAt: new Date() }),
      ),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    job: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "job1", creditHoldId: "hold1" }),
    },
    subscription: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ plan: { key: overrides?.planTier ?? "creator" } }),
    },
  };

  const passes = {
    finishedDurationMs: vi.fn().mockResolvedValue(MEDIA_DURATION_MS),
    startAutocut: vi.fn().mockResolvedValue({ jobId: "job1", passId: "pass1" }),
    startZoom: vi.fn().mockResolvedValue({ jobId: "job1", passId: "pass1" }),
    startReframe: vi.fn().mockResolvedValue({ jobId: "job1", passId: "pass1" }),
    startSfx: vi.fn().mockResolvedValue({ jobId: "job1", passId: "pass1" }),
    startMusic: vi.fn().mockResolvedValue({ jobId: "job2", passId: "pass2" }),
    startTextFx: vi.fn().mockResolvedValue({ jobId: "job1", passId: "pass1" }),
  };

  const planner = {
    generate: vi.fn().mockResolvedValue({
      output: plannerOutput,
      provider: "mock",
      templateVersion: "edit-plan@1",
    }),
  };

  const edg = {
    document: vi.fn().mockRejectedValue(new Error("edg/not_initialised")),
    segments: vi.fn().mockRejectedValue(new Error("edg/not_initialised")),
  };

  const service = new PromptedEditsService(
    prisma as unknown as PrismaService,
    {} as unknown as TranscriptsRepository,
    edg as unknown as EdgService,
    passes as unknown as PassesService,
    planner as unknown as PlannerClient,
  );

  return { service, prisma, passes, planner, edg };
}

describe("PromptedEditsService.plan", () => {
  let deps: Deps;
  beforeEach(() => {
    deps = buildService();
  });

  it("builds an EditPlanInput from the project's facts and stores a schema-/guardrail-valid plan", async () => {
    const row = await deps.service.plan({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      prompt: "Cut the silences and add music",
      engine: "flash",
    });

    expect(deps.planner.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Cut the silences and add music", planTier: "creator" }),
    );
    expect(deps.prisma.promptedEditPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "planned",
          sourceDurationMs: MEDIA_DURATION_MS,
          provider: "mock",
        }),
      }),
    );
    expect(row).toMatchObject({ status: "planned" });
  });

  it("rejects a plan that violates the budget cap for the workspace's plan tier (guardrail, not schema)", async () => {
    // starter's cap is 2 passes (packages/prompts edit-plan.ts) — 3 exceeds it.
    deps = buildService({
      planTier: "starter",
      plannerOutput: {
        passes: [
          { kind: "autocut", params: {} },
          { kind: "zoom", params: {} },
          { kind: "textfx", params: {} },
        ],
        rationale: ["a", "b", "c"],
      },
    });

    await expect(
      deps.service.plan({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        prompt: "Do everything",
        engine: "flash",
      }),
    ).rejects.toMatchObject({ code: "prompted_edit/guardrail_violation" });

    expect(deps.prisma.promptedEditPlan.create).not.toHaveBeenCalled();
  });

  it("rejects the pro engine tier on a plan that does not allow it (guardrail)", async () => {
    deps = buildService({
      planTier: "creator",
      plannerOutput: {
        passes: [{ kind: "autocut", params: { engine: "pro" } }],
        rationale: ["best quality"],
      },
    });

    await expect(
      deps.service.plan({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        prompt: "best quality please",
        engine: "pro",
      }),
    ).rejects.toMatchObject({ code: "prompted_edit/guardrail_violation" });
  });

  it("refuses to plan when the project's media is not ready", async () => {
    deps.prisma.mediaAsset.findFirst.mockResolvedValue(null);

    await expect(
      deps.service.plan({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        prompt: "anything",
        engine: "flash",
      }),
    ).rejects.toMatchObject({ code: "prompted_edit/media_not_ready" });
  });
});

describe("PromptedEditsService.run", () => {
  let deps: Deps;
  beforeEach(() => {
    deps = buildService();
    deps.prisma.promptedEditPlan.findFirst.mockResolvedValue({
      id: PLAN_ID,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      status: "planned",
      engine: "flash",
      sourceDurationMs: MEDIA_DURATION_MS,
      plan: twoPassOutput(),
    });
  });

  it("holds credits on the source duration by folding the macro hold into the FIRST chain job only", async () => {
    const result = await deps.service.run(PROJECT_ID, WORKSPACE_ID, PLAN_ID);

    expect(result.firstPassKind).toBe("autocut");
    expect(result.status).toBe("running");
    expect(result.holdTenths).toBeGreaterThan(0);

    // The macro hold rides on the FIRST job's own worst-case cost
    // (`costOverrideTenths`), never a second, separate `reserve()` call —
    // `CreditHold.jobId` is unique, `reserve()` cannot be called twice for
    // one job (see `prompted-chain.ts`'s `startChainKind` doc comment).
    expect(deps.passes.startAutocut).toHaveBeenCalledWith(
      expect.objectContaining({ costOverrideTenths: result.holdTenths }),
    );
    expect(deps.passes.startAutocut.mock.calls[0]?.[0]).not.toHaveProperty("skipCredits", true);

    expect(deps.prisma.promptedEditPlan.update).toHaveBeenCalledWith({
      where: { id: PLAN_ID },
      data: {
        status: "running",
        holdId: "hold1",
        holdTenths: result.holdTenths,
        currentJobId: "job1",
        remainingKinds: ["music"],
      },
    });
  });

  it("never starts a chain-internal pass with its own real credit charge", async () => {
    await deps.service.run(PROJECT_ID, WORKSPACE_ID, PLAN_ID);
    // Only the first pass (autocut here) is started by run() itself; the
    // rest is `PromptedChainAdvancer`'s job, each with `skipCredits: true`
    // (proven in `apps/api/test/prompted-edits.e2e-spec.ts` end to end).
    expect(deps.passes.startMusic).not.toHaveBeenCalled();
  });

  it("refuses to run a plan that is not \"planned\"", async () => {
    deps.prisma.promptedEditPlan.findFirst.mockResolvedValue({
      id: PLAN_ID,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      status: "running",
      engine: "flash",
      sourceDurationMs: MEDIA_DURATION_MS,
      plan: twoPassOutput(),
    });

    await expect(deps.service.run(PROJECT_ID, WORKSPACE_ID, PLAN_ID)).rejects.toMatchObject({
      code: "prompted_edit/invalid_status",
    });
  });

  it("404s for a plan that does not exist in this project/workspace", async () => {
    deps.prisma.promptedEditPlan.findFirst.mockResolvedValue(null);

    await expect(deps.service.run(PROJECT_ID, WORKSPACE_ID, "no-such-plan")).rejects.toThrow(
      AppException,
    );
  });

  it("starts the chain's passes in PROMPTED_EDIT_CHAIN_ORDER, not the plan's own array order", async () => {
    deps.prisma.promptedEditPlan.findFirst.mockResolvedValue({
      id: PLAN_ID,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      status: "planned",
      engine: "flash",
      sourceDurationMs: MEDIA_DURATION_MS,
      // music listed BEFORE autocut in the plan's own array...
      plan: {
        passes: [
          { kind: "music", params: {} },
          { kind: "autocut", params: { preset: "standard" } },
        ],
        rationale: ["music", "autocut"],
      },
    });

    const result = await deps.service.run(PROJECT_ID, WORKSPACE_ID, PLAN_ID);

    // ...but autocut still runs first (chain order), music is queued after.
    expect(result.firstPassKind).toBe("autocut");
    expect(deps.passes.startAutocut).toHaveBeenCalled();
    expect(deps.passes.startMusic).not.toHaveBeenCalled();
  });
});

describe("guardrail violation error shape", () => {
  it("carries HTTP 422 (unprocessable) so a client can distinguish it from a 4xx input error", async () => {
    const deps = buildService({
      planTier: "starter",
      plannerOutput: {
        passes: [
          { kind: "autocut", params: {} },
          { kind: "zoom", params: {} },
          { kind: "textfx", params: {} },
        ],
        rationale: ["a", "b", "c"],
      },
    });

    try {
      await deps.service.plan({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        prompt: "too much",
        engine: "flash",
      });
      expect.unreachable("plan() should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });
});
