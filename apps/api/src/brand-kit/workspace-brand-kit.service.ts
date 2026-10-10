import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException, PrismaService } from "../common/index.js";
import {
  type UpdateWorkspaceBrandKitInput,
  type WorkspaceBrandKitView,
} from "./workspace-brand-kit.dto.js";

export const DEFAULT_WORKSPACE_BRAND_KIT: Omit<WorkspaceBrandKitView, "workspaceId"> = {
  id: undefined,
  logoUrl: null,
  logoPosition: "TOP_LEFT",
  logoScalePct: 15,
  logoOpacity: 0.85,
  socialHandle: null,
  introVideoUrl: null,
  outroVideoUrl: null,
};

@Injectable()
export class WorkspaceBrandKitService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<WorkspaceBrandKitView> {
    const kit = await this.prisma.workspaceBrandKit.findUnique({
      where: { workspaceId },
    });

    if (!kit) {
      return {
        workspaceId,
        ...DEFAULT_WORKSPACE_BRAND_KIT,
      };
    }

    return {
      id: kit.id,
      workspaceId: kit.workspaceId,
      logoUrl: kit.logoUrl,
      logoPosition: (kit.logoPosition as WorkspaceBrandKitView["logoPosition"]) || "TOP_LEFT",
      logoScalePct: kit.logoScalePct,
      logoOpacity: kit.logoOpacity,
      socialHandle: kit.socialHandle,
      introVideoUrl: kit.introVideoUrl,
      outroVideoUrl: kit.outroVideoUrl,
      createdAt: kit.createdAt.toISOString(),
      updatedAt: kit.updatedAt.toISOString(),
    };
  }

  async update(
    workspaceId: string,
    input: UpdateWorkspaceBrandKitInput,
  ): Promise<WorkspaceBrandKitView> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });

    if (!workspace) {
      throw new AppException(
        "workspace/not_found",
        "Workspace not found.",
        HttpStatus.NOT_FOUND,
      );
    }

    const saved = await this.prisma.workspaceBrandKit.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        logoUrl: input.logoUrl ?? null,
        logoPosition: input.logoPosition ?? "TOP_LEFT",
        logoScalePct: input.logoScalePct ?? 15,
        logoOpacity: input.logoOpacity ?? 0.85,
        socialHandle: input.socialHandle ?? null,
        introVideoUrl: input.introVideoUrl ?? null,
        outroVideoUrl: input.outroVideoUrl ?? null,
      },
      update: {
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
        ...(input.logoPosition !== undefined ? { logoPosition: input.logoPosition } : {}),
        ...(input.logoScalePct !== undefined ? { logoScalePct: input.logoScalePct } : {}),
        ...(input.logoOpacity !== undefined ? { logoOpacity: input.logoOpacity } : {}),
        ...(input.socialHandle !== undefined ? { socialHandle: input.socialHandle } : {}),
        ...(input.introVideoUrl !== undefined ? { introVideoUrl: input.introVideoUrl } : {}),
        ...(input.outroVideoUrl !== undefined ? { outroVideoUrl: input.outroVideoUrl } : {}),
      },
    });

    return {
      id: saved.id,
      workspaceId: saved.workspaceId,
      logoUrl: saved.logoUrl,
      logoPosition: (saved.logoPosition as WorkspaceBrandKitView["logoPosition"]) || "TOP_LEFT",
      logoScalePct: saved.logoScalePct,
      logoOpacity: saved.logoOpacity,
      socialHandle: saved.socialHandle,
      introVideoUrl: saved.introVideoUrl,
      outroVideoUrl: saved.outroVideoUrl,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }
}
