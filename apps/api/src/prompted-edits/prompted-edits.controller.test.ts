import { describe, expect, it, vi } from "vitest";

import { PromptedEditsController } from "./prompted-edits.controller.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { PromptedEditPlan } from "@prisma/client";

const WORKSPACE_ID = "01JWORKSPACE00000000000000";
const PROJECT_ID = "01JPROJECT000000000000000A";
const PLAN_ID = "01JPLAN0000000000000000000";
const USER_ID = "01JUSER0000000000000000000";

function harness() {
  const promptedEdits = { plan: vi.fn(), get: vi.fn(), run: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new PromptedEditsController(promptedEdits as never, audit as never);
  return { controller, promptedEdits, audit };
}

function principal(): AuthPrincipal {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "editor",
    kind: "user",
    jti: "j",
  };
}

function planRow(): PromptedEditPlan {
  return {
    id: PLAN_ID,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    prompt: "cut the dead air and add zoom on the key line",
    engine: "flash",
    plan: { passes: [], rationale: [] },
    status: "planned",
    holdTenths: 30,
    settledTenths: null,
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
    updatedAt: new Date("2026-09-03T00:00:00.000Z"),
  } as unknown as PromptedEditPlan;
}

describe("PromptedEditsController.create", () => {
  it("creates a plan and writes an audit row for it", async () => {
    const h = harness();
    h.promptedEdits.plan.mockResolvedValue(planRow());

    const result = await h.controller.create(principal(), PROJECT_ID, {
      prompt: "cut the dead air and add zoom on the key line",
      engine: "flash",
    });

    expect(result.id).toBe(PLAN_ID);
    expect(h.promptedEdits.plan).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prompted_edit.plan.created",
        resource: "prompted_edit_plan",
        resourceId: PLAN_ID,
        workspaceId: WORKSPACE_ID,
        actorId: USER_ID,
        data: expect.objectContaining({ projectId: PROJECT_ID, engine: "flash" }),
      }),
    );
  });
});

describe("PromptedEditsController.run", () => {
  it("runs a plan and writes an audit row for it", async () => {
    const h = harness();
    const runResult = {
      planId: PLAN_ID,
      jobId: "01JJOB0000000000000000000A",
      firstPassKind: "autocut",
      status: "running",
      holdTenths: 30,
      holdCredits: "3.0",
    };
    h.promptedEdits.run.mockResolvedValue(runResult);

    const result = await h.controller.run(principal(), PROJECT_ID, PLAN_ID);

    expect(result).toEqual(runResult);
    expect(h.promptedEdits.run).toHaveBeenCalledWith(PROJECT_ID, WORKSPACE_ID, PLAN_ID);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prompted_edit.plan.run",
        resource: "prompted_edit_plan",
        resourceId: PLAN_ID,
        workspaceId: WORKSPACE_ID,
        actorId: USER_ID,
        data: expect.objectContaining({ projectId: PROJECT_ID }),
      }),
    );
  });
});
