import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { type Env } from "@montaj/config";

import { PublicViewerController } from "./public-viewer.controller.js";
import { ShareLinksController } from "./share-links.controller.js";

function createControllers(flags: Record<string, unknown> = { "shares.public": false }) {
  const env: Env = {
    FEATURE_FLAGS_JSON: flags,
    WEB_ORIGIN: "https://test.montaj.dev",
  } as unknown as Env;

  const shareLinks = {
    resolve: vi.fn(async () => ({
      shareLink: { id: "link-1", scope: "view" },
      project: { id: "p-1", title: "Test Project", reviewStatus: "none", aspect: "16:9" },
      requiresPassword: false,
      unlocked: true,
    })),
    recordView: vi.fn(async () => undefined),
    unlock: vi.fn(async () => "session-token"),
    report: vi.fn(async () => ({ id: "report-1", dueAt: "2026-09-20" })),
    decide: vi.fn(async () => ({ projectId: "p-1", reviewStatus: "approved" })),
    preview: vi.fn(async () => ({
      proxyUrl: "https://cdn.test/proxy.mp4",
      durationMs: 5000,
      aspect: "16:9",
      projection: {},
    })),
    create: vi.fn(async () => ({ id: "link-1", url: "https://test.montaj.dev/s/token1" })),
    list: vi.fn(async () => []),
    revoke: vi.fn(async () => undefined),
  } as never;

  const publicViewer = new PublicViewerController(shareLinks, env);
  const shareLinksController = new ShareLinksController(shareLinks, env);

  return { publicViewer, shareLinksController, shareLinks };
}

describe("Public Shares Surface Availability (RLS-006)", () => {
  describe("PublicViewerController (/s/:token)", () => {
    it("fails closed (404) when public shares are disabled by default", async () => {
      const { publicViewer } = createControllers({ "shares.public": false });

      await expect(publicViewer.resolve("token1", undefined)).rejects.toThrow(NotFoundException);
      await expect(publicViewer.unlock("token1", { password: "pass" })).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        publicViewer.report("token1", { category: "other", details: "Spam link" }),
      ).rejects.toThrow(NotFoundException);
      await expect(publicViewer.decide("token1", { decision: "approved" })).rejects.toThrow(
        NotFoundException,
      );
      await expect(publicViewer.preview("token1", undefined)).rejects.toThrow(NotFoundException);
    });

    it("fails closed (404) when shares.public is explicitly false", async () => {
      const { publicViewer } = createControllers({ "shares.public": false });

      await expect(publicViewer.resolve("token1", undefined)).rejects.toThrow(NotFoundException);
    });

    it("admits requests when shares.public is true", async () => {
      const { publicViewer, shareLinks } = createControllers({ "shares.public": true });

      const res = await publicViewer.resolve("token1", undefined);
      expect(res.projectId).toBe("p-1");
      expect((shareLinks as any).resolve).toHaveBeenCalledWith("token1", undefined);
    });
  });

  describe("ShareLinksController (/projects/:projectId/share-links)", () => {
    it("fails closed (404) when public shares are disabled by default", async () => {
      const { shareLinksController } = createControllers({ "shares.public": false });

      await expect(
        shareLinksController.create("ws-1", "u-1", "01JBZ0Q4T7R8N4H1V0J9K2M3P7", { scope: "view" }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        shareLinksController.list("ws-1", "01JBZ0Q4T7R8N4H1V0J9K2M3P7"),
      ).rejects.toThrow(NotFoundException);
      await expect(
        shareLinksController.revoke("ws-1", "u-1", "01JBZ0Q4T7R8N4H1V0J9K2M3P7", "link-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("fails closed (404) when shares.public is explicitly false", async () => {
      const { shareLinksController } = createControllers({ "shares.public": false });

      await expect(
        shareLinksController.list("ws-1", "01JBZ0Q4T7R8N4H1V0J9K2M3P7"),
      ).rejects.toThrow(NotFoundException);
    });

    it("admits requests when shares.public is true", async () => {
      const { shareLinksController, shareLinks } = createControllers({ "shares.public": true });

      const res = await shareLinksController.list("ws-1", "01JBZ0Q4T7R8N4H1V0J9K2M3P7");
      expect(res).toEqual([]);
      expect((shareLinks as any).list).toHaveBeenCalled();
    });
  });
});
