import { z } from "zod";

/**
 * The parts of `@montaj/publishing-contracts` (REP-005) this module runs on,
 * restated rather than imported.
 *
 * The API does not depend on that package yet. Adding a workspace dependency
 * means a `pnpm install` in the release worktree at deploy time (CLAUDE.md §1),
 * and a deploy that missed it would stop the API from booting with "cannot find
 * module". So the names live here, and `publishing.contract.test.ts` reads the
 * contract's own source and fails the moment the two drift apart - the same
 * arrangement the web app has with `@montaj/repurpose-contracts`
 * (`components/repurpose/copy.test.ts`). Importing it for real later is a
 * one-line change per symbol.
 */

export const PUBLISHING_SCHEMA_VERSION = 1 as const;

/** Canonical Aksharo provider ids: OUR names, never the publishing service's. */
export const PUBLISH_PROVIDERS = [
  "instagram",
  "facebook",
  "threads",
  "youtube",
  "linkedin",
  "tiktok",
  "x",
  "snapchat",
  "whatsapp",
] as const;
export type PublishProvider = (typeof PUBLISH_PROVIDERS)[number];

/**
 * Safe error classes. A provider's own message is never shown to a person: it
 * is mapped onto one of these, and only the class decides what happens next.
 */
export const PUBLISH_ERROR_CODES = [
  "publishing/validation_failed",
  "publishing/permission_missing",
  "publishing/token_expired",
  "publishing/account_disconnected",
  "publishing/rate_limited",
  "publishing/media_rejected",
  "publishing/content_rejected",
  "publishing/duplicate_content",
  "publishing/provider_unavailable",
  "publishing/uncertain_outcome",
  "publishing/artifact_stale",
  "publishing/not_approved",
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/** What the dispatcher is allowed to do next, per error code. */
export const PUBLISH_ERROR_BEHAVIOUR = Object.freeze({
  "publishing/validation_failed": "permanent",
  "publishing/permission_missing": "permanent",
  "publishing/token_expired": "needs_user",
  "publishing/account_disconnected": "needs_user",
  "publishing/rate_limited": "retry_after",
  "publishing/media_rejected": "permanent",
  "publishing/content_rejected": "permanent",
  "publishing/duplicate_content": "permanent",
  "publishing/provider_unavailable": "retryable",
  "publishing/uncertain_outcome": "reconcile_first",
  "publishing/artifact_stale": "permanent",
  "publishing/not_approved": "permanent",
} as const satisfies Record<PublishErrorCode, string>);

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * `publish.dispatch@1`: an id and an attempt number, nothing else. Copy,
 * settings, the channel and the video are read from the frozen row when the
 * job runs, so a job that waited in Redis cannot post stale text.
 */
export const PublishDispatchPayloadSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  publishTargetId: UlidSchema,
  attemptNo: z.int().positive().max(1_000),
});
export type PublishDispatchPayload = z.infer<typeof PublishDispatchPayloadSchema>;

/** `publish.reconcile@1`: ask the service what actually happened. Bounded. */
export const PublishReconcilePayloadSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  publishTargetId: UlidSchema,
  checkNo: z.int().positive().max(100),
});
export type PublishReconcilePayload = z.infer<typeof PublishReconcilePayloadSchema>;

/** `publish.dispatch:{targetId}:{attemptNo}` - one job per attempt, never reused. */
export function publishDispatchJobKey(targetId: string, attemptNo: number): string {
  return `publish.dispatch:${targetId}:${String(attemptNo)}`;
}

/** `publish.reconcile:{targetId}` - one live reconcile per target at a time. */
export function publishReconcileJobKey(targetId: string): string {
  return `publish.reconcile:${targetId}`;
}
