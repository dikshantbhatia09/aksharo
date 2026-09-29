import { isSupportedProvider, rulesFor, type VideoShape } from "./platforms.js";
import { SHAPE_OF_ASPECT } from "../repurpose/repurpose.constants.js";

import type { PostStatus, PostView } from "./publishing.dto.js";
import type { $Enums, Prisma } from "@prisma/client";

/** What a post's row needs joined in to be shown. */
export const POST_INCLUDE = {
  channelConnection: { select: { id: true, displayName: true, avatarUrl: true } },
  variant: { select: { aspect: true } },
  clip: { select: { runId: true } },
} as const satisfies Prisma.PublishTargetInclude;

export type PostRow = Prisma.PublishTargetGetPayload<{ include: typeof POST_INCLUDE }>;

/** The eleven ledger states, as the five a person needs. */
export function postStatusOf(state: $Enums.PublishTargetStatus): PostStatus {
  switch (state) {
    case "published":
      return "posted";
    case "scheduled":
      return "scheduled";
    case "cancelled":
      return "cancelled";
    case "failed_retryable":
    case "failed_permanent":
    case "action_required":
      return "failed";
    default:
      // draft, validating, ready, submitted, processing: on its way.
      return "posting";
  }
}

/** Retry sends the same post again; a permanent refusal needs a new one instead. */
export function canRetry(state: $Enums.PublishTargetStatus): boolean {
  return state === "failed_retryable" || state === "action_required";
}

/** Cancel is for a post not yet out and not being sent this very moment. */
export function canCancel(state: $Enums.PublishTargetStatus): boolean {
  return (
    state === "ready" ||
    state === "scheduled" ||
    state === "failed_retryable" ||
    state === "failed_permanent" ||
    state === "action_required" ||
    state === "draft"
  );
}

function copyText(copy: Prisma.JsonValue): { title: string | null; body: string } {
  const record =
    typeof copy === "object" && copy !== null && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)
      : {};
  return {
    title: typeof record["title"] === "string" ? record["title"] : null,
    body: typeof record["body"] === "string" ? record["body"] : "",
  };
}

export function toPostView(row: PostRow): PostView {
  const status = postStatusOf(row.status);
  const copy = copyText(row.copy);
  const shape: VideoShape | null = SHAPE_OF_ASPECT[row.variant.aspect] ?? null;
  const failed = status === "failed";
  return {
    id: row.id,
    clipId: row.clipId,
    runId: row.clip.runId,
    channel:
      row.channelConnection === null
        ? null
        : {
            id: row.channelConnection.id,
            name: row.channelConnection.displayName ?? "Account",
            avatarUrl: row.channelConnection.avatarUrl,
          },
    provider: row.provider,
    platform: isSupportedProvider(row.provider) ? rulesFor(row.provider).label : row.provider,
    shape,
    status,
    state: row.status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    url: row.externalUrl,
    title: copy.title,
    text: copy.body,
    error:
      failed && row.lastErrorCode !== null
        ? {
            code: row.lastErrorCode,
            message: row.lastErrorSafeMessage ?? "It did not go out.",
          }
        : null,
    // A waiting post's line ("waiting for a free posting slot"), or why it was cancelled.
    note: !failed && row.lastErrorSafeMessage !== null ? row.lastErrorSafeMessage : null,
    canRetry: canRetry(row.status),
    canCancel: canCancel(row.status),
    createdAt: row.createdAt.toISOString(),
  };
}
