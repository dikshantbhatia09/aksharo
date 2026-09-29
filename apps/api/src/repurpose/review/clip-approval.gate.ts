import { Injectable } from "@nestjs/common";

import { NOT_REQUIRED, approvalCheck, type ApprovalCheck } from "./review-state.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";

/**
 * "Clips need approval before posting" (2026-10-03), as posting asks it.
 *
 * The setting is a key of the workspace's settings document
 * (`workspaces.settings.clipsNeedApproval`, off unless set), changed through
 * `PATCH /workspaces/{id}` by an owner or admin. While it is on, the publishing
 * routes post a clip only when it is approved, and only a video the approval
 * pinned (`review-state.ts`): a clip edited after its approval, or a shape made
 * after it, is not what was approved.
 *
 * Stateless over the database, so the publishing module binds it again rather
 * than importing the review module (the pattern `IdempotencyService` follows).
 * It reads the stored decision and does not return a stale approval to pending
 * itself: coverage is checked against the exact export about to be posted, so
 * a video that changed since is refused whether or not the review has caught
 * up yet.
 */
@Injectable()
export class ClipApprovalGate {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether the workspace requires approval before posting. */
  async required(workspaceId: string): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    return clipsNeedApproval(workspace?.settings);
  }

  async forClip(workspaceId: string, clipId: string): Promise<ApprovalCheck> {
    return (await this.forClips(workspaceId, [clipId])).get(clipId) ?? NOT_REQUIRED;
  }

  /** One check per clip; every clip is present in the answer. */
  async forClips(
    workspaceId: string,
    clipIds: readonly string[],
  ): Promise<Map<string, ApprovalCheck>> {
    const ids = [...new Set(clipIds)];
    if (!(await this.required(workspaceId))) {
      return new Map(ids.map((id) => [id, NOT_REQUIRED]));
    }
    const reviews = await this.prisma.clipReview.findMany({
      where: { workspaceId, clipId: { in: ids } },
      select: { clipId: true, state: true, videos: true },
    });
    const byClip = new Map(reviews.map((review) => [review.clipId, review]));
    return new Map(ids.map((id) => [id, approvalCheck(true, byClip.get(id) ?? null)]));
  }
}

/** The setting, from a workspace's settings document: on only when `true`. */
export function clipsNeedApproval(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    !Array.isArray(settings) &&
    (settings as Record<string, unknown>)["clipsNeedApproval"] === true
  );
}
