import { beforeEach, describe, expect, it, vi } from "vitest";

import { StickersController } from "./stickers.controller.js";
import type { StickersService } from "./stickers.service.js";
import type { CommonAuditService } from "../common/audit/audit.service.js";

describe("StickersController", () => {
  let controller: StickersController;
  let mockService: Partial<StickersService>;
  let mockAudit: Partial<CommonAuditService>;

  beforeEach(() => {
    mockService = {
      search: vi.fn().mockResolvedValue({
        assets: [],
        total: 0,
        page: 1,
        limit: 24,
        categories: ["All"],
      }),
      getTrending: vi.fn().mockResolvedValue({
        assets: [],
        total: 0,
        page: 1,
        limit: 24,
        categories: ["All"],
      }),
      getCategories: vi.fn().mockReturnValue(["Shocked Reactions", "Arrows & Pointers"]),
      recommendReactionMemes: vi.fn().mockReturnValue({
        recommendations: [],
      }),
      cacheStickerAsset: vi.fn().mockResolvedValue({
        cachedKey: "stickers/giphy/abc.webm",
        cachedUrl: "https://assets.aksharo.com/stickers/giphy/abc.webm",
        isTransparent: true,
        format: "webm",
        sizeBytes: 2048,
      }),
    };

    mockAudit = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    controller = new StickersController(
      mockService as StickersService,
      mockAudit as CommonAuditService,
    );
  });

  it("delegates search to service", async () => {
    const query = { query: "shocked", limit: 10 };
    await controller.search(query);
    expect(mockService.search).toHaveBeenCalledWith(query);
  });

  it("delegates trending to service", async () => {
    const query = { limit: 12 };
    await controller.getTrending(query);
    expect(mockService.getTrending).toHaveBeenCalledWith(query);
  });

  it("returns categories map", async () => {
    const res = await controller.getCategories();
    expect(res.categories).toEqual(["Shocked Reactions", "Arrows & Pointers"]);
  });

  it("delegates recommend to service", async () => {
    const body = { transcript: "hilarious joke haha" };
    await controller.recommend(body);
    expect(mockService.recommendReactionMemes).toHaveBeenCalledWith(body);
  });

  it("caches asset and records audit log", async () => {
    const body = {
      assetId: "abc",
      sourceUrl: "https://example.com/sticker.gif",
      provider: "giphy",
      type: "sticker",
      isTransparent: true,
    };
    const res = await controller.cacheAsset("ws-1", "user-1", body);
    expect(mockService.cacheStickerAsset).toHaveBeenCalledWith(body);
    expect(res.cachedKey).toBe("stickers/giphy/abc.webm");
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.sticker.asset_cached",
        actorId: "user-1",
        workspaceId: "ws-1",
      }),
    );
  });
});
