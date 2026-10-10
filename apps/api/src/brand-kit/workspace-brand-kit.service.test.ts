import { describe, expect, it, vi } from "vitest";
import { WorkspaceBrandKitService, DEFAULT_WORKSPACE_BRAND_KIT } from "./workspace-brand-kit.service.js";
import type { PrismaService } from "../common/index.js";

const WS = "01JBKWS0000000000000000000";

describe("WorkspaceBrandKitService", () => {
  it("returns defaults when no workspace brand kit row exists", async () => {
    const prisma = {
      workspaceBrandKit: {
        findUnique: vi.fn(async () => null),
      },
    };

    const service = new WorkspaceBrandKitService(prisma as unknown as PrismaService);
    const result = await service.get(WS);

    expect(prisma.workspaceBrandKit.findUnique).toHaveBeenCalledWith({ where: { workspaceId: WS } });
    expect(result).toEqual({
      workspaceId: WS,
      ...DEFAULT_WORKSPACE_BRAND_KIT,
    });
  });

  it("returns existing workspace brand kit and bumpers when found", async () => {
    const row = {
      id: "wbk_123",
      workspaceId: WS,
      logoUrl: "https://cdn.example.com/logo.png",
      logoPosition: "TOP_LEFT",
      logoScalePct: 18,
      logoOpacity: 0.9,
      socialHandle: "@podcast",
      introVideoUrl: "https://cdn.example.com/intro.mp4",
      outroVideoUrl: "https://cdn.example.com/outro.mp4",
      createdAt: new Date("2026-10-10T12:00:00Z"),
      updatedAt: new Date("2026-10-10T12:00:00Z"),
    };

    const prisma = {
      workspaceBrandKit: {
        findUnique: vi.fn(async () => row),
      },
    };

    const service = new WorkspaceBrandKitService(prisma as unknown as PrismaService);
    const result = await service.get(WS);

    expect(result.id).toBe("wbk_123");
    expect(result.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(result.introVideoUrl).toBe("https://cdn.example.com/intro.mp4");
    expect(result.outroVideoUrl).toBe("https://cdn.example.com/outro.mp4");
  });

  it("upserts brand settings and clamps/updates values", async () => {
    const prisma = {
      workspace: {
        findUnique: vi.fn(async () => ({ id: WS })),
      },
      workspaceBrandKit: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
          id: "wbk_new",
          ...create,
          createdAt: new Date("2026-10-10T12:00:00Z"),
          updatedAt: new Date("2026-10-10T12:00:00Z"),
        })),
      },
    };

    const service = new WorkspaceBrandKitService(prisma as unknown as PrismaService);
    const result = await service.update(WS, {
      logoUrl: "https://cdn.example.com/logo2.png",
      logoPosition: "TOP_RIGHT",
      logoScalePct: 25,
      logoOpacity: 0.8,
      socialHandle: "@acme",
      introVideoUrl: "https://cdn.example.com/intro2.mp4",
      outroVideoUrl: "https://cdn.example.com/outro2.mp4",
    });

    expect(result.id).toBe("wbk_new");
    expect(result.logoPosition).toBe("TOP_RIGHT");
    expect(result.logoScalePct).toBe(25);
    expect(result.socialHandle).toBe("@acme");
  });

  it("throws 404 if workspace does not exist on update", async () => {
    const prisma = {
      workspace: {
        findUnique: vi.fn(async () => null),
      },
      workspaceBrandKit: {
        upsert: vi.fn(),
      },
    };

    const service = new WorkspaceBrandKitService(prisma as unknown as PrismaService);
    await expect(service.update("invalid_ws", { logoScalePct: 15 })).rejects.toThrow("Workspace not found.");
  });
});
