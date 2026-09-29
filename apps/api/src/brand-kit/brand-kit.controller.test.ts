import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS } from "@montaj/edg";

import { BrandKitController } from "./brand-kit.controller.js";
import { ROLES_KEY } from "../common/guards/roles.guard.js";

import type { BrandKitService } from "./brand-kit.service.js";
import type { CommonAuditService } from "../common/audit/audit.service.js";

const WS = "01JBKWS0000000000000000000";
const USER = "01JBKUSER00000000000000000";
const ASSET = "01JBKASSET0000000000000000";

function harness() {
  const view = { exists: true } as never;
  const brandKits = {
    view: vi.fn(async () => view),
    update: vi.fn(async () => view),
    createLogoUpload: vi.fn(async () => ({ assetId: ASSET })),
    completeLogo: vi.fn(async () => ({ view, replaced: "01JBKOLD000000000000000000" })),
    removeLogo: vi.fn(async () => ({ view, removed: null as string | null })),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new BrandKitController(
    brandKits as unknown as BrandKitService,
    audit as unknown as CommonAuditService,
  );
  return { controller, brandKits, audit, view };
}

describe("BrandKitController", () => {
  it("lets viewers read the kit and only editors change it", () => {
    const reflector = new Reflector();
    const roles = (method: keyof BrandKitController) =>
      // eslint-disable-next-line security/detect-object-injection -- a method name from a closed list of the controller's own
      reflector.get<string[]>(ROLES_KEY, BrandKitController.prototype[method]);
    expect(roles("get")).toEqual(["viewer"]);
    for (const method of ["update", "createLogoUpload", "completeLogo", "removeLogo"] as const) {
      expect(roles(method), method).toEqual(["editor"]);
    }
  });

  it("audits every change, naming who made it and in which workspace", async () => {
    const h = harness();
    await h.controller.get(WS);
    expect(h.audit.record).not.toHaveBeenCalled();

    await h.controller.update(WS, USER, DEFAULT_BRAND_KIT_SETTINGS);
    expect(h.brandKits.update).toHaveBeenCalledWith(WS, DEFAULT_BRAND_KIT_SETTINGS);
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "workspace.brand_kit.updated",
        actorId: USER,
        workspaceId: WS,
      }),
    );

    await h.controller.completeLogo(WS, USER, ASSET, { contentType: "image/png" });
    expect(h.brandKits.completeLogo).toHaveBeenCalledWith(WS, USER, ASSET, {
      contentType: "image/png",
    });
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "workspace.brand_kit.logo_set",
        resourceId: ASSET,
        data: { replaced: "01JBKOLD000000000000000000" },
      }),
    );

    // Taking off a logo there was not is not an event.
    const calls = h.audit.record.mock.calls.length;
    await h.controller.removeLogo(WS, USER);
    expect(h.audit.record.mock.calls.length).toBe(calls);
    h.brandKits.removeLogo.mockResolvedValueOnce({ view: h.view, removed: ASSET });
    await h.controller.removeLogo(WS, USER);
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "workspace.brand_kit.logo_removed", resourceId: ASSET }),
    );
  });
});
