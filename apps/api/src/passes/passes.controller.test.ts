import { describe, expect, it, vi } from "vitest";

import { PassesController } from "./passes.controller.js";

import type { AuthPrincipal } from "../common/guards/index.js";

const WORKSPACE_ID = "01JWORKSPACE00000000000000";
const PROJECT_ID = "01JPROJECT000000000000000A";
const USER_ID = "01JUSER0000000000000000000";

function harness() {
  const passes = {
    startAutocut: vi.fn(),
    startZoom: vi.fn(),
    startReframe: vi.fn(),
    startTextFx: vi.fn(),
    startSfx: vi.fn(),
    startMusic: vi.fn(),
    list: vi.fn(),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new PassesController(passes as never, audit as never);
  return { controller, passes, audit };
}

function principal(): AuthPrincipal {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "editor",
    kind: "web",
    jti: "j",
  };
}

const accepted = (passId: string) => ({
  jobId: "01JJOB0000000000000000000A",
  passId,
  status: "queued",
});

describe("PassesController — every start route writes an audit row", () => {
  it("startAutocut", async () => {
    const h = harness();
    h.passes.startAutocut.mockResolvedValue(accepted("01JPASS000000000000000AUT"));

    const result = await h.controller.startAutocut(principal(), PROJECT_ID, { preset: "standard" });

    expect(result.passId).toBe("01JPASS000000000000000AUT");
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pass.autocut.started",
        resource: "edg_pass",
        resourceId: "01JPASS000000000000000AUT",
        workspaceId: WORKSPACE_ID,
        actorId: USER_ID,
        data: expect.objectContaining({ projectId: PROJECT_ID }),
      }),
    );
  });

  it("startZoom", async () => {
    const h = harness();
    h.passes.startZoom.mockResolvedValue(accepted("01JPASS000000000000000ZOM"));

    await h.controller.startZoom(principal(), PROJECT_ID, { preset: "standard" });

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pass.zoom.started",
        resourceId: "01JPASS000000000000000ZOM",
      }),
    );
  });

  it("startReframe", async () => {
    const h = harness();
    h.passes.startReframe.mockResolvedValue(accepted("01JPASS000000000000000RFM"));

    await h.controller.startReframe(principal(), PROJECT_ID, { aspect: "9:16" });

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pass.reframe.started",
        resourceId: "01JPASS000000000000000RFM",
      }),
    );
  });

  it("startTextFx", async () => {
    const h = harness();
    h.passes.startTextFx.mockResolvedValue(accepted("01JPASS000000000000000TFX"));

    await h.controller.startTextFx(principal(), PROJECT_ID);

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pass.textfx.started",
        resourceId: "01JPASS000000000000000TFX",
      }),
    );
  });

  it("startSfx", async () => {
    const h = harness();
    h.passes.startSfx.mockResolvedValue(accepted("01JPASS000000000000000SFX"));

    await h.controller.startSfx(principal(), PROJECT_ID);

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pass.sfx.started",
        resourceId: "01JPASS000000000000000SFX",
      }),
    );
  });

  it("startMusic", async () => {
    const h = harness();
    h.passes.startMusic.mockResolvedValue(accepted("01JPASS000000000000000MUS"));

    await h.controller.startMusic(principal(), PROJECT_ID);

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pass.music.started",
        resourceId: "01JPASS000000000000000MUS",
      }),
    );
  });
});
