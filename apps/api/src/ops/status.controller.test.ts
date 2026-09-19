import { describe, expect, it, vi } from "vitest";

import { StatusSnapshotSchema } from "./status-snapshot.js";
import { StatusController, unknownSnapshot } from "./status.controller.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

function harness() {
  const findFirst = vi.fn(async () => null);
  const prisma = {
    opsStatusSnapshot: { findFirst },
  } as unknown as PrismaService;
  const controller = new StatusController(prisma);
  return { controller, findFirst };
}

describe("StatusController", () => {
  describe("statusJson", () => {
    it("returns unknown state with no invented components when no snapshot exists", async () => {
      const { controller, findFirst } = harness();
      const snapshot = await controller.statusJson();

      expect(findFirst).toHaveBeenCalledWith({ orderBy: { publishedAt: "desc" } });
      expect(snapshot.components).toEqual([]);
      expect(snapshot.generatedAt).toBe("unknown");
      expect(snapshot.incidents).toEqual([]);
      expect(snapshot.overall).toBe("degraded");

      // Verify it conforms strictly to StatusSnapshotSchema
      const parsed = StatusSnapshotSchema.safeParse(snapshot);
      expect(parsed.success).toBe(true);
    });

    it("returns published snapshot payload when one exists", async () => {
      const { controller, findFirst } = harness();
      const published = {
        generatedAt: new Date().toISOString(),
        overall: "operational" as const,
        components: [{ id: "api", label: "API", status: "operational" as const }],
        incidents: [],
      };
      findFirst.mockResolvedValueOnce({
        id: "snap-1",
        publishedAt: new Date(),
        payload: published,
      } as never);

      const snapshot = await controller.statusJson();
      expect(snapshot).toEqual(published);
    });
  });

  describe("statusRss", () => {
    it("renders RSS with fallback date and no invalid date when no snapshot exists", async () => {
      const { controller } = harness();
      const rss = await controller.statusRss();

      expect(rss).toContain("<title>Aksharo status</title>");
      expect(rss).toContain("<link>https://aksharo.ai/status</link>");
      expect(rss).not.toContain("Invalid Date");
    });
  });

  describe("unknownSnapshot", () => {
    it("has zero components and valid schema", () => {
      const snapshot = unknownSnapshot();
      expect(snapshot.components).toHaveLength(0);
      expect(snapshot.generatedAt).toBe("unknown");
      expect(StatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
    });
  });
});
