import { describe, expect, it, vi, beforeEach } from "vitest";

import { StockController } from "./stock.controller.js";
import type { StockImportResponse, StockSearchResponse } from "./stock.dto.js";
import type { StockService } from "./stock.service.js";
import type { CommonAuditService } from "../common/audit/audit.service.js";

describe("StockController", () => {
  let controller: StockController;
  let mockStockService: {
    search: ReturnType<typeof vi.fn>;
    getCategories: ReturnType<typeof vi.fn>;
    importOrCacheAsset: ReturnType<typeof vi.fn>;
  };
  let mockAudit: {
    record: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockStockService = {
      search: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        perPage: 20,
        cached: false,
      } as StockSearchResponse),
      getCategories: vi.fn().mockReturnValue(["All", "Technology", "Business"]),
      importOrCacheAsset: vi.fn().mockResolvedValue({
        assetId: "sb-1",
        provider: "storyblocks",
        cachedKey: "stock-cache/storyblocks/sb-1.mp4",
        cachedUrl: "https://s3.aksharo.com/cached.mp4",
        sizeBytes: 5000000,
        status: "ready",
      } as StockImportResponse),
    };

    mockAudit = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    controller = new StockController(
      mockStockService as unknown as StockService,
      mockAudit as unknown as CommonAuditService,
    );
  });

  it("delegates search to StockService", async () => {
    const res = await controller.search({ query: "drone", orientation: "portrait" });
    expect(mockStockService.search).toHaveBeenCalledWith({
      query: "drone",
      orientation: "portrait",
    });
    expect(res.total).toBe(0);
  });

  it("returns categories list", async () => {
    const res = await controller.getCategories();
    expect(res.categories).toContain("Technology");
  });

  it("imports and edge caches asset, recording audit event", async () => {
    const res = await controller.importAsset("ws-1", "user-1", {
      assetId: "sb-1",
      provider: "storyblocks",
      downloadVideoUrl: "https://storyblocks.com/download.mp4",
    });

    expect(mockStockService.importOrCacheAsset).toHaveBeenCalledWith({
      assetId: "sb-1",
      provider: "storyblocks",
      downloadVideoUrl: "https://storyblocks.com/download.mp4",
    });
    expect(res.status).toBe("ready");
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.stock.asset_cached",
        actorId: "user-1",
        workspaceId: "ws-1",
      }),
    );
  });
});
