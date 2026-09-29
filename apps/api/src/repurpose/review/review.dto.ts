import { z } from "zod";

import type { VideoShape } from "@montaj/repurpose-contracts";

import { VideoPinsSchema } from "./review-state.js";
import {
  COMMENT_MAX,
  LABEL_MAX,
  LINK_DEFAULT_DAYS,
  LINK_MAX_DAYS,
  LINK_MIN_DAYS,
  NAME_MAX,
} from "./review.constants.js";
import { zodDto } from "../../common/index.js";

import type { ReviewPermissions, ReviewState } from "./review-state.js";
import type { $Enums } from "@prisma/client";

/**
 * Request and response shapes for clip review (2026-10-03): the team's routes
 * under `/repurpose/runs/{runId}` and the client's under `/review/{token}`.
 */

/** A clip is at most a few minutes long; a day is a generous bound on "a moment in it". */
const atMsSchema = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60_000);

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Control characters out, runs of space folded: a name is shown to other people. */
function clean(value: string): string {
  return value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

const noteSchema = z.string().trim().max(COMMENT_MAX);
const bodySchema = z.string().trim().min(1).max(COMMENT_MAX);
const nameSchema = z
  .string()
  .max(NAME_MAX * 2)
  .transform(clean)
  .pipe(z.string().min(1).max(NAME_MAX));

// --- The team's routes -------------------------------------------------------

/**
 * `POST /repurpose/runs/{runId}/clips/{clipId}/review`. `expect` is what the
 * page showed (shape to export id): when the clip's videos have changed since,
 * the decision is refused (409 `review/video_changed`) rather than pinned to a
 * video nobody looked at.
 */
export const reviewDecisionSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  note: noteSchema.optional(),
  expect: VideoPinsSchema.optional(),
});
export class ReviewDecisionDto extends zodDto(reviewDecisionSchema) {}
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;

export const addClipCommentSchema = z.object({
  body: bodySchema,
  atMs: atMsSchema.optional(),
});
export class AddClipCommentDto extends zodDto(addClipCommentSchema) {}
export type AddClipCommentInput = z.infer<typeof addClipCommentSchema>;

export const resolveClipCommentSchema = z.object({ resolved: z.boolean() });
export class ResolveClipCommentDto extends zodDto(resolveClipCommentSchema) {}

export const createReviewLinkSchema = z.object({
  expiresInDays: z.number().int().min(LINK_MIN_DAYS).max(LINK_MAX_DAYS).default(LINK_DEFAULT_DAYS),
  requireName: z.boolean().default(false),
  label: z.string().trim().min(1).max(LABEL_MAX).transform(clean).optional(),
});
export class CreateReviewLinkDto extends zodDto(createReviewLinkSchema) {}
export type CreateReviewLinkInput = z.infer<typeof createReviewLinkSchema>;

// --- The client's routes -----------------------------------------------------

/**
 * `POST /review/{token}/clips/{clipId}/decision`. `expect` is the export id of
 * the video the page played; `name` is required when the link says so.
 */
export const clientDecisionSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  name: nameSchema.optional(),
  note: noteSchema.optional(),
  expect: z.string().min(1).max(64).optional(),
});
export class ClientDecisionDto extends zodDto(clientDecisionSchema) {}
export type ClientDecisionInput = z.infer<typeof clientDecisionSchema>;

export const clientCommentSchema = z.object({
  body: bodySchema,
  atMs: atMsSchema.optional(),
  name: nameSchema.optional(),
});
export class ClientCommentDto extends zodDto(clientCommentSchema) {}
export type ClientCommentInput = z.infer<typeof clientCommentSchema>;

// --- Views -------------------------------------------------------------------

export type ActorKind = $Enums.ReviewActorKind;

/** Who made a decision or wrote a comment, as a person reads it. */
export interface ReviewActorView {
  readonly kind: ActorKind;
  /** A member's name (or email's first part), a client's own name, or null. */
  readonly name: string | null;
  /** The member's user id; null for a client or Aksharo. */
  readonly userId: string | null;
  /** The link a client came through: its hint and the team's label for it. */
  readonly link: {
    readonly id: string;
    readonly hint: string;
    readonly label: string | null;
  } | null;
}

export interface ReviewVideoView {
  readonly shape: VideoShape;
  readonly exportId: string;
  /** Signed, short-lived. */
  readonly url: string | null;
  readonly durationMs: number | null;
}

/** One clip's review, on the run page. */
export interface ClipReviewSummaryView {
  readonly clipId: string;
  readonly state: ReviewState;
  readonly decidedBy: ReviewActorView | null;
  readonly decidedAt: string | null;
  /** `video_changed` when Aksharo put it back to pending. */
  readonly reason: string | null;
  /** Shapes the decision covers, and shapes with a video it does not (made since). */
  readonly covered: readonly VideoShape[];
  readonly uncovered: readonly VideoShape[];
  /** The videos a decision now would be made on (`expect` sends them back). */
  readonly videos: Readonly<Partial<Record<VideoShape, string>>>;
  /** The 9:16 video, or the first shape there is, for a card that shows none. */
  readonly video: ReviewVideoView | null;
  readonly comments: { readonly total: number; readonly open: number };
}

export interface RunReviewView {
  readonly runId: string;
  /** The workspace requires approval before a clip is posted. */
  readonly needsApproval: boolean;
  readonly permissions: ReviewPermissions;
  readonly clips: readonly ClipReviewSummaryView[];
}

export interface ClipCommentView {
  readonly id: string;
  readonly clipId: string;
  readonly author: ReviewActorView;
  readonly body: string;
  readonly atMs: number | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  /** Whether the caller may resolve or reopen it. */
  readonly canResolve: boolean;
}

export interface ClipReviewEventView {
  readonly id: string;
  readonly state: ReviewState;
  readonly actor: ReviewActorView;
  readonly note: string | null;
  readonly reason: string | null;
  readonly shapes: readonly VideoShape[];
  readonly createdAt: string;
}

export interface ClipReviewDetailView {
  readonly clip: ClipReviewSummaryView;
  readonly events: readonly ClipReviewEventView[];
  readonly comments: readonly ClipCommentView[];
}

export interface ReviewLinkView {
  readonly id: string;
  readonly runId: string;
  readonly hint: string;
  readonly label: string | null;
  readonly requireName: boolean;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** `live`, `expired` or `revoked`. */
  readonly status: "live" | "expired" | "revoked";
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly visits: number;
  readonly lastVisitAt: string | null;
  /** Decisions and comments that came through it. */
  readonly decisions: number;
  readonly comments: number;
}

/** A link as it is made: the only time the full address exists outside the page it opens. */
export interface CreatedReviewLinkView extends ReviewLinkView {
  readonly url: string;
}

// --- The client's page -------------------------------------------------------

export interface PublicClipView {
  readonly id: string;
  readonly title: string;
  readonly hook: string | null;
  readonly description: string | null;
  readonly hashtags: readonly string[];
  readonly durationMs: number | null;
  /** The 9:16 captioned video; null while it is being made. */
  readonly video: {
    readonly exportId: string;
    readonly url: string;
    readonly durationMs: number | null;
  } | null;
  /** The last decision made through THIS link, and whether the video changed since. */
  readonly yourDecision: {
    readonly state: Exclude<ReviewState, "pending">;
    readonly at: string;
    readonly name: string | null;
    readonly changedSince: boolean;
  } | null;
  /** Comments made through this link on this clip (never the team's own thread). */
  readonly comments: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly body: string;
    readonly atMs: number | null;
    readonly createdAt: string;
  }[];
}

export interface PublicReviewView {
  /** The video's title. Nothing about the workspace. */
  readonly title: string;
  readonly requireName: boolean;
  readonly expiresAt: string;
  readonly clips: readonly PublicClipView[];
}
