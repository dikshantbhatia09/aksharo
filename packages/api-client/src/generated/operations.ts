/**
 * GENERATED FILE — do not edit.
 *
 * Produced by `pnpm gen:client` from the API's OpenAPI document. The full spec is
 * `openapi.json` beside this package's manifest; this module is the part a
 * consumer can hold a compile-time reference to.
 */

export interface ApiOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
}

/** Version of the API the document was generated from. */
export const API_VERSION = "0.1.0";

export const API_OPERATIONS = [
  {
    operationId: "applyEdgOps",
    method: "POST",
    path: "/projects/{projectId}/edg/ops",
    tags: ["edg"],
    summary: "Apply a batch of ops (CONTRACTS §2)",
  },
  {
    operationId: "AuthController_consumeMagicLink",
    method: "POST",
    path: "/auth/magic-link/consume",
    tags: ["auth"],
    summary: "Exchange a magic-link token for tokens",
  },
  {
    operationId: "AuthController_exchange",
    method: "POST",
    path: "/auth/token/exchange",
    tags: ["auth"],
    summary: "Switch the active workspace",
  },
  {
    operationId: "AuthController_joinWaitlist",
    method: "POST",
    path: "/auth/parental-waitlist",
    tags: ["auth"],
    summary: "Join the parental-consent waitlist",
  },
  {
    operationId: "AuthController_listSessions",
    method: "GET",
    path: "/auth/sessions",
    tags: ["auth"],
    summary: "List this account's live sessions",
  },
  {
    operationId: "AuthController_login",
    method: "POST",
    path: "/auth/login",
    tags: ["auth"],
    summary: "Sign in with email and password",
  },
  {
    operationId: "AuthController_logout",
    method: "POST",
    path: "/auth/logout",
    tags: ["auth"],
    summary: "Revoke a refresh-token family",
  },
  {
    operationId: "AuthController_refresh",
    method: "POST",
    path: "/auth/refresh",
    tags: ["auth"],
    summary: "Rotate a refresh token",
  },
  {
    operationId: "AuthController_requestMagicLink",
    method: "POST",
    path: "/auth/magic-link",
    tags: ["auth"],
    summary: "Email a single-use sign-in link (15 minutes)",
  },
  {
    operationId: "AuthController_revokeSession",
    method: "DELETE",
    path: "/auth/sessions/{sessionId}",
    tags: ["auth"],
    summary: "Revoke one session (and its refresh-token family)",
  },
  {
    operationId: "AuthController_signUp",
    method: "POST",
    path: "/auth/signup",
    tags: ["auth"],
    summary: "Create an account",
  },
  {
    operationId: "AuthController_verifyEmail",
    method: "POST",
    path: "/auth/verify-email",
    tags: ["auth"],
    summary: "Confirm an email address with a single-use token",
  },
  {
    operationId: "cancelJob",
    method: "POST",
    path: "/jobs/{id}/cancel",
    tags: ["jobs"],
    summary: "Cancel a queued or running job",
  },
  {
    operationId: "DeviceController_decide",
    method: "POST",
    path: "/auth/device/approve",
    tags: ["auth"],
    summary: "Approve or decline a device sign-in",
  },
  {
    operationId: "DeviceController_describe",
    method: "GET",
    path: "/auth/device/code/{userCode}",
    tags: ["auth"],
    summary: "What is asking for approval",
  },
  {
    operationId: "DeviceController_poll",
    method: "POST",
    path: "/auth/device/token",
    tags: ["auth"],
    summary: "Poll for the result",
  },
  {
    operationId: "DeviceController_request",
    method: "POST",
    path: "/auth/device/code",
    tags: ["auth"],
    summary: "Start a device sign-in",
  },
  {
    operationId: "discardDeadLetter",
    method: "POST",
    path: "/admin/dlq/{id}/discard",
    tags: ["admin"],
    summary: "Discard one dead letter",
  },
  {
    operationId: "discardDeadLetters",
    method: "POST",
    path: "/admin/dlq/discard",
    tags: ["admin"],
    summary: "Discard many dead letters",
  },
  {
    operationId: "getDeadLetter",
    method: "GET",
    path: "/admin/dlq/{id}",
    tags: ["admin"],
    summary: "One dead letter, by entry id or by job id",
  },
  {
    operationId: "getDeadLetterStats",
    method: "GET",
    path: "/admin/dlq/stats",
    tags: ["admin"],
    summary: "Per-queue dead-letter counts",
  },
  {
    operationId: "getHealth",
    method: "GET",
    path: "/health",
    tags: ["health"],
    summary: "Liveness probe",
  },
  {
    operationId: "getJob",
    method: "GET",
    path: "/jobs/{id}",
    tags: ["jobs"],
    summary: "Fetch one job",
  },
  {
    operationId: "getProjectEdg",
    method: "GET",
    path: "/projects/{projectId}/edg",
    tags: ["edg"],
    summary: "The hot document, its revision and the first page of segments",
  },
  {
    operationId: "getReadiness",
    method: "GET",
    path: "/health/ready",
    tags: ["health"],
    summary: "Readiness probe (db, redis, storage)",
  },
  {
    operationId: "listDeadLetters",
    method: "GET",
    path: "/admin/dlq",
    tags: ["admin"],
    summary: "List dead-lettered jobs, newest first",
  },
  {
    operationId: "listEdgPasses",
    method: "GET",
    path: "/projects/{projectId}/edg/passes",
    tags: ["edg"],
    summary: "Every AI pass on the document, with its items",
  },
  {
    operationId: "listEdgPassItems",
    method: "GET",
    path: "/projects/{projectId}/edg/passes/{passId}/items",
    tags: ["edg"],
    summary: "One pass's proposals, optionally filtered by review state",
  },
  {
    operationId: "listEdgRevisions",
    method: "GET",
    path: "/projects/{projectId}/edg/revisions",
    tags: ["edg"],
    summary: "The op log from `from` onwards",
  },
  {
    operationId: "listEdgSegments",
    method: "GET",
    path: "/projects/{projectId}/edg/segments",
    tags: ["edg"],
    summary: "One page of segments, ordered by `seq`",
  },
  {
    operationId: "listEdgSnapshots",
    method: "GET",
    path: "/projects/{projectId}/edg/snapshots",
    tags: ["edg"],
    summary: "Revisions a snapshot was taken at, newest first",
  },
  {
    operationId: "listJobEvents",
    method: "GET",
    path: "/jobs/{id}/events",
    tags: ["jobs"],
    summary: "The job's event log, oldest first",
  },
  {
    operationId: "listJobs",
    method: "GET",
    path: "/jobs",
    tags: ["jobs"],
    summary: "List the workspace's jobs, newest first",
  },
  {
    operationId: "OAuthController_callback",
    method: "GET",
    path: "/auth/oauth/google/callback",
    tags: ["auth"],
    summary: "Google redirects here",
  },
  {
    operationId: "OAuthController_complete",
    method: "POST",
    path: "/auth/oauth/complete",
    tags: ["auth"],
    summary: "Exchange the handoff code for tokens",
  },
  {
    operationId: "OAuthController_start",
    method: "GET",
    path: "/auth/oauth/google/start",
    tags: ["auth"],
    summary: "Begin Google sign-in",
  },
  {
    operationId: "replayDeadLetter",
    method: "POST",
    path: "/admin/dlq/{id}/replay",
    tags: ["admin"],
    summary: "Replay one dead letter",
  },
  {
    operationId: "replayDeadLetters",
    method: "POST",
    path: "/admin/dlq/replay",
    tags: ["admin"],
    summary: "Replay many dead letters",
  },
  {
    operationId: "resegmentEdg",
    method: "POST",
    path: "/projects/{projectId}/edg/resegment",
    tags: ["edg"],
    summary: "Re-run segmentation over the whole document",
  },
  {
    operationId: "restoreEdgSnapshot",
    method: "POST",
    path: "/projects/{projectId}/edg/snapshots/{revision}/restore",
    tags: ["edg"],
    summary: "Restore a snapshot as a new revision",
  },
] as const satisfies readonly ApiOperation[];

/** Every operation id in the document, as a union. */
export type ApiOperationId = (typeof API_OPERATIONS)[number]["operationId"];

/** Look one up by id. */
export function findOperation(operationId: ApiOperationId): ApiOperation | undefined {
  return API_OPERATIONS.find((operation) => operation.operationId === operationId);
}
