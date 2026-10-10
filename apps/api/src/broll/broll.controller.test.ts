import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { BrollController } from "./broll.controller.js";
import { RATE_LIMIT_KEY } from "../common/guards/rate-limit.guard.js";
import { ROLES_KEY } from "../common/guards/roles.guard.js";

import type { BrollLibraryService } from "./broll.service.js";
import type { CommonAuditService } from "../common/audit/audit.service.js";

const WS = "01JBRWS0000000000000000000";
const USER = "01JBRUSER00000000000000000";
const ASSET = "01JBRASSET0000000000000000";

function harness() {
  const item = { assetId: ASSET, tags: ["taj mahal"] } as never;
  const library = {
    list: vi.fn(async () => ({ items: [] })),
    createUpload: vi.fn(async () => ({ assetId: ASSET })),
    complete: vi.fn(async () => ({ item, created: true })),
    update: vi.fn(async () => item),
    remove: vi.fn(async () => true),
    searchStock: vi.fn(async () => ({ photos: [] })),
    saveStock: vi.fn(async () => ({ item, created: true })),
  };
  const stockProvider = {
    searchVideos: vi.fn(async () => []),
    getCues: vi.fn(async () => []),
    createCue: vi.fn(async () => ({})),
    updateCue: vi.fn(async () => ({})),
    deleteCue: vi.fn(async () => true),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new BrollController(
    library as unknown as BrollLibraryService,
    stockProvider as never,
    audit as unknown as CommonAuditService,
  );
  return { controller, library, stockProvider, audit, item };
}

describe("BrollController", () => {
  it("lets viewers read the library and only editors change it or search stock", () => {
    const reflector = new Reflector();
    const roles = (method: keyof BrollController) =>
      // eslint-disable-next-line security/detect-object-injection -- a method name from a closed list of the controller's own
      reflector.get<string[]>(ROLES_KEY, BrollController.prototype[method]);
    expect(roles("list")).toEqual(["viewer"]);
    for (const method of [
      "createUpload",
      "complete",
      "update",
      "remove",
      "searchStock",
      "saveStock",
    ] as const) {
      expect(roles(method), method).toEqual(["editor"]);
    }
  });

  it("rate-limits uploads, stock searches and stock saves per user", () => {
    const reflector = new Reflector();
    const limit = (method: keyof BrollController) =>
      reflector.get<{ name: string; by: string }[]>(
        RATE_LIMIT_KEY,
        // eslint-disable-next-line security/detect-object-injection -- a method name from a closed list of the controller's own
        BrollController.prototype[method],
      );
    expect(limit("createUpload")).toEqual([expect.objectContaining({ by: "user" })]);
    expect(limit("complete")).toEqual([expect.objectContaining({ by: "user" })]);
    expect(limit("searchStock")).toEqual([
      expect.objectContaining({ name: "broll:stock-search:user" }),
    ]);
    expect(limit("saveStock")).toEqual([
      expect.objectContaining({ name: "broll:stock-save:user" }),
    ]);
  });

  it("audits every picture added, changed or deleted, and nothing that changed nothing", async () => {
    const h = harness();
    await h.controller.list(WS);
    await h.controller.createUpload(WS, { contentType: "image/png", sizeBytes: 9 });
    await h.controller.searchStock({ query: "chai", page: 1 });
    expect(h.audit.record).not.toHaveBeenCalled();

    await h.controller.complete(WS, USER, ASSET, { contentType: "image/png" });
    expect(h.library.complete).toHaveBeenCalledWith(WS, USER, ASSET, { contentType: "image/png" });
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "workspace.broll.picture_added",
        resource: "broll_asset",
        resourceId: ASSET,
        actorId: USER,
        workspaceId: WS,
      }),
    );

    // Completing the same upload again adds nothing.
    h.library.complete.mockResolvedValueOnce({ item: h.item, created: false });
    const calls = h.audit.record.mock.calls.length;
    await h.controller.complete(WS, USER, ASSET, { contentType: "image/png" });
    expect(h.audit.record.mock.calls.length).toBe(calls);

    await h.controller.update(WS, USER, ASSET, { tags: ["chai"] });
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "workspace.broll.picture_updated", resourceId: ASSET }),
    );

    await h.controller.saveStock(WS, USER, { photoId: 1181 });
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "workspace.broll.stock_saved",
        data: { provider: "pexels", photoId: 1181 },
      }),
    );

    expect(await h.controller.remove(WS, USER, ASSET)).toEqual({ deleted: true });
    expect(h.audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "workspace.broll.picture_removed", resourceId: ASSET }),
    );
    h.library.remove.mockResolvedValueOnce(false);
    const before = h.audit.record.mock.calls.length;
    expect(await h.controller.remove(WS, USER, ASSET)).toEqual({ deleted: false });
    expect(h.audit.record.mock.calls.length).toBe(before);
  });
});
