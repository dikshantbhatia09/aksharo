/** Error codes, audit actions and limits `workspaces/teams/` owns (CONTRACTS §8). */

export const TEAMS_ERRORS = {
  notOwner: "workspace/not_owner",
  membershipNotFound: "workspace/member_not_found",
  membershipNotActive: "workspace/member_not_active",
  transferConfirmationRequired: "workspace/transfer_confirmation_required",
  transferTokenInvalid: "workspace/transfer_token_invalid",
} as const;

export type TeamsErrorCode = (typeof TEAMS_ERRORS)[keyof typeof TEAMS_ERRORS];

/** `<domain>.<noun>.<verb>`, past tense — the convention `A05_AUDIT_ACTIONS` set. */
export const TEAMS_AUDIT_ACTIONS = {
  seatsSynced: "workspace.seats.synced",
  seatSyncFailed: "workspace.seats.sync_failed",
  creditsPooled: "workspace.credits.pooled",
  ownershipTransferred: "workspace.ownership.transferred",
  ownershipTransferConfirmationSent: "workspace.ownership.transfer_confirmation_sent",
  clientTagSet: "workspace.client_tag.set",
} as const;

export type TeamsAuditAction = (typeof TEAMS_AUDIT_ACTIONS)[keyof typeof TEAMS_AUDIT_ACTIONS];

/** How long a transfer-ownership confirmation token stays redeemable. */
export const TRANSFER_CONFIRMATION_TTL_SEC = 10 * 60;
