import { redisKeyPrefix } from "../common/redis/redis-keys.js";

import type { RateLimitRule } from "../common/guards/index.js";

/** Error codes, limits and Redis keys the workspaces module owns. */

export const WORKSPACE_ERRORS = {
  /** The caller is not an active member of the workspace named in the path (T4). */
  notAMember: "auth/not_a_member",
  notFound: "workspace/not_found",
  slugTaken: "workspace/slug_taken",
  /** Deleting it would leave the user with nowhere to work. */
  lastRemaining: "workspace/last_remaining",
  taxProfileInvalid: "workspace/tax_profile_invalid",
  /** Currency is locked for the life of a subscription (04 §Tax, D41). */
  taxProfileLocked: "workspace/tax_profile_locked",
  memberNotFound: "workspace/member_not_found",
  memberAlreadyPresent: "workspace/member_already_present",
  /** A workspace has exactly one owner, who cannot be removed or demoted. */
  ownerImmutable: "workspace/owner_immutable",
  invitationNotFound: "workspace/invitation_not_found",
  seatLimitReached: "workspace/seat_limit_reached",
} as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERRORS)[keyof typeof WORKSPACE_ERRORS];

export const WORKSPACE_RATE_LIMITS = {
  /** Creating a workspace costs a row, not a session, so the bucket is per user. */
  createUser: { name: "workspaces:create:user", by: "user", capacity: 10, refillPerSec: 10 / 3600 },
  /** An invitation mails an address the inviter chose; bound the volume. */
  inviteUser: { name: "workspaces:invite:user", by: "user", capacity: 30, refillPerSec: 30 / 3600 },
} as const satisfies Record<string, RateLimitRule>;

/** 07 §Workspaces: the computed entitlement is cached for 60 seconds. */
export const ENTITLEMENT_CACHE_TTL_SEC = 60;

/** How many members a workspace may hold before B08's seat billing exists. */
export const MAX_MEMBERS_PER_WORKSPACE = 50;

/** A function since A23b, for the reason {@link redisKeyPrefix} explains. */
export function workspacesRedisPrefix(): string {
  return `${redisKeyPrefix()}:workspaces`;
}

export const workspacesRedisKeys = {
  entitlement: (workspaceId: string) => `${workspacesRedisPrefix()}:entitlement:${workspaceId}`,
} as const;
