import { Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { postizWorkspaceIds } from "./postiz/postiz-env.js";
import { PostizClient } from "./postiz/postiz.client.js";
import { PUBLISHING_FLAGS } from "./publishing.constants.js";
import { ENV } from "../config/config.module.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { UnavailableReason } from "./publishing.dto.js";

/**
 * Who may post, before anything asks Postiz (2026-09-29). Three gates, all of
 * which must pass:
 *
 *   1. **The flag** `publishing_postiz` is on for the workspace - the same
 *      mechanism as `repurpose_flow`: `FEATURE_FLAGS_JSON` first (the
 *      deployment's kill switch), then the `feature_flags` row and its targets.
 *   2. **The workspace is named in `POSTIZ_WORKSPACE_IDS`.** One Postiz
 *      organisation is one set of social accounts; the flag being on for a
 *      workspace must not be enough to post to somebody else's Instagram.
 *   3. **A key is set** (`POSTIZ_API_KEY`) and its URL is usable.
 *
 * Whether Postiz answers, and has channels, is the directory's to say.
 */
export interface AccessState {
  readonly enabled: boolean;
  readonly allowed: boolean;
  readonly configured: boolean;
  /** The first gate that failed, or null when all three passed. */
  readonly reason: Extract<
    UnavailableReason,
    "flag_off" | "not_this_workspace" | "not_configured"
  > | null;
}

@Injectable()
export class PublishingAccess {
  /** Where `POSTIZ_WORKSPACE_IDS` is read from, per call; a field so a test can set it. */
  environment: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly entitlements: EntitlementService,
    private readonly postiz: PostizClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** A rollout flag for this workspace: the env override wins, then the flag row. */
  async flag(workspaceId: string, flag: string): Promise<boolean> {
    // eslint-disable-next-line security/detect-object-injection -- `flag` is one of the module's own constants
    const override = this.env.FEATURE_FLAGS_JSON[flag];
    if (typeof override === "boolean") return override;
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    const flags = entitlement.entitlements.flags as Record<string, boolean> | undefined;
    // eslint-disable-next-line security/detect-object-injection -- as above
    return flags?.[flag] === true;
  }

  async state(workspaceId: string): Promise<AccessState> {
    const enabled = await this.flag(workspaceId, PUBLISHING_FLAGS.postiz);
    const allowed = postizWorkspaceIds(this.environment).includes(workspaceId);
    const configured = this.postiz.configured;
    const reason = !enabled
      ? "flag_off"
      : !allowed
        ? "not_this_workspace"
        : !configured
          ? "not_configured"
          : null;
    return { enabled, allowed, configured, reason };
  }

  /** TikTok has its own flag on top (its review and consent rules are stricter). */
  async tiktokEnabled(workspaceId: string): Promise<boolean> {
    return this.flag(workspaceId, PUBLISHING_FLAGS.tiktok);
  }
}
