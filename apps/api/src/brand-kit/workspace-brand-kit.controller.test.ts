import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceBrandKitController } from "./workspace-brand-kit.controller.js";
import { ROLES_KEY } from "../common/guards/roles.guard.js";

import type { WorkspaceBrandKitService } from "./workspace-brand-kit.service.js";
import type { CommonAuditService } from "../common/audit/audit.service.js";

const WS = "01JBKWS0000000000000000000";
const USER = "01JBKUSER00000000000000000";

function harness() {
  const kit = {
    id: "01JBK_KIT_123",
    workspaceId: WS,
    logoUrl: "https://assets.aksharo.com/logo.png",
    logoPosition: "TOP_LEFT" as const,
    logoScalePct: 15,
    logoOpacity: 0.85,
    socialHandle: "@crestmond",
    introVideoUrl: "https://assets.aksharo.com/intro.mp4",
    outroVideoUrl: "https://assets.aksharo.com/outro.mp4",
  };

  const service = {
    get: vi.fn(async () => kit),
    update: vi.fn(async () => kit),
  };

  const audit = { record: vi.fn(async () => undefined) };

  const controller = new WorkspaceBrandKitController(
    service as unknown as WorkspaceBrandKitService,
    audit as unknown as CommonAuditService,
  );

  return { controller, service, audit, kit };
}

describe("WorkspaceBrandKitController", () => {
  it("enforces viewer role on GET and editor role on PUT", () => {
    const reflector = new Reflector();
    const roles = (method: keyof WorkspaceBrandKitController) =>
      reflector.get<string[]>(ROLES_KEY, WorkspaceBrandKitController.prototype[method]);

    expect(roles("get")).toEqual(["viewer"]);
    expect(roles("update")).toEqual(["editor"]);
  });

  it("fetches active workspace brand kit and bumper settings", async () => {
    const h = harness();
    const res = await h.controller.get(WS);

    expect(h.service.get).toHaveBeenCalledWith(WS);
    expect(res).toEqual(h.kit);
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it("updates workspace brand kit, bumpers, and records audit entry", async () => {
    const h = harness();
    const updatePayload = {
      logoUrl: "https://assets.aksharo.com/new_logo.png",
      logoPosition: "TOP_RIGHT" as const,
      logoScalePct: 20,
      logoOpacity: 0.9,
      socialHandle: "@aksharo",
      introVideoUrl: "https://assets.aksharo.com/new_intro.mp4",
      outroVideoUrl: "https://assets.aksharo.com/new_outro.mp4",
    };

    const res = await h.controller.update(WS, USER, updatePayload);

    expect(h.service.update).toHaveBeenCalledWith(WS, updatePayload);
    expect(res).toEqual(h.kit);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.brand_kit.updated",
        resource: "workspace_brand_kit",
        actorId: USER,
        workspaceId: WS,
        data: expect.objectContaining({
          logoPosition: "TOP_LEFT",
          logoScalePct: 15,
          hasIntro: true,
          hasOutro: true,
        }),
      }),
    );
  });
});
