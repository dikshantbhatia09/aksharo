import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { RepurposeCoversController } from "./repurpose-covers.controller.js";
import { ROLES_KEY } from "../common/guards/roles.guard.js";
import { AppException } from "../common/index.js";

import type { RepurposeService } from "./repurpose.service.js";
import type { BrandKitService } from "../brand-kit/brand-kit.service.js";
import type { CommonAuditService } from "../common/audit/audit.service.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const COVER = "01JCC0VER00000000000000000";

function harness(options: { available?: boolean } = {}) {
  const repurpose = {
    assertAvailable: vi.fn(async () => {
      if (options.available === false) {
        throw new AppException("repurpose/not_available", "off", 404);
      }
    }),
  };
  const view = {
    assetId: COVER,
    format: "png",
    width: 1_400,
    height: 1_400,
    sizeBytes: 9,
    url: "u",
  };
  const brandKits = {
    createCoverUpload: vi.fn(async () => ({ assetId: COVER })),
    completeCover: vi.fn(async () => view),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new RepurposeCoversController(
    repurpose as unknown as RepurposeService,
    brandKits as unknown as BrandKitService,
    audit as unknown as CommonAuditService,
  );
  return { controller, repurpose, brandKits, audit };
}

describe("RepurposeCoversController", () => {
  it("lets only editors upload a cover", () => {
    const reflector = new Reflector();
    for (const method of ["createUpload", "complete"] as const) {
      expect(
        // eslint-disable-next-line security/detect-object-injection -- a method name from a closed list of the controller's own
        reflector.get<string[]>(ROLES_KEY, RepurposeCoversController.prototype[method]),
        method,
      ).toEqual(["editor"]);
    }
  });

  it("signs an upload and audits the cover it keeps, naming who and where", async () => {
    const h = harness();
    await h.controller.createUpload(WS, { contentType: "image/png", sizeBytes: 9 });
    expect(h.brandKits.createCoverUpload).toHaveBeenCalledWith(WS, {
      contentType: "image/png",
      sizeBytes: 9,
    });
    expect(h.audit.record).not.toHaveBeenCalled();

    const view = await h.controller.complete(WS, USER, COVER, { contentType: "image/png" });
    expect(view.assetId).toBe(COVER);
    expect(h.brandKits.completeCover).toHaveBeenCalledWith(WS, USER, COVER, {
      contentType: "image/png",
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repurpose.cover.uploaded",
        resource: "brand_asset",
        resourceId: COVER,
        actorId: USER,
        workspaceId: WS,
      }),
    );
  });

  it("answers 404 while the clips surface is off, before anything is signed", async () => {
    const h = harness({ available: false });
    await expect(
      h.controller.createUpload(WS, { contentType: "image/png", sizeBytes: 9 }),
    ).rejects.toMatchObject({ code: "repurpose/not_available" });
    await expect(
      h.controller.complete(WS, USER, COVER, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: "repurpose/not_available" });
    expect(h.brandKits.createCoverUpload).not.toHaveBeenCalled();
    expect(h.brandKits.completeCover).not.toHaveBeenCalled();
  });
});
