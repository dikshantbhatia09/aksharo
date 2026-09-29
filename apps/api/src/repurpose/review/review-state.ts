import { z } from "zod";

import { VIDEO_SHAPES, type VideoShape } from "@montaj/repurpose-contracts";

import { roleAtLeast } from "../../common/guards/index.js";

import type { $Enums } from "@prisma/client";

/**
 * Clip review (2026-10-03): the rules, as pure functions. The services read and
 * write; everything that decides is here, and tested on its own.
 *
 * **Approval belongs to the clip.** A reviewer decides on a moment - its cut,
 * words, captions and title - and the client link shows one video per clip. A
 * decision PINS the captioned video it was made on in every shape the reviewer
 * could see ({@link VideoPins}): all of a clip's shapes for a member, who has
 * them on the run page; the 9:16 alone for a client, who is shown that one.
 *
 *   * **Posting under the approval rule** sends only a pinned video: a shape
 *     made after the approval is not covered, and the platform gets a covered
 *     shape instead (every platform takes 9:16), until someone approves again.
 *   * **A new video in a pinned shape** - the clip edited after the decision and
 *     its captioned video made again - returns the clip to `pending`
 *     ({@link reopenedBy}), approved or changes-requested alike: what was
 *     decided on is no longer what would go out.
 */

export type ReviewState = $Enums.ClipReviewState;
export type ReviewDecision = Exclude<ReviewState, "pending">;
export type ActorKind = $Enums.ReviewActorKind;

/** Shape to the export id of the captioned video a decision was made on. */
export type VideoPins = Readonly<Partial<Record<VideoShape, string>>>;

export const VideoPinsSchema = z.partialRecord(z.enum(VIDEO_SHAPES), z.string().min(1).max(64));

/** The pins a JSON column holds; anything unreadable is no pins at all. */
export function pinsOf(value: unknown): VideoPins {
  const parsed = VideoPinsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** The one video per shape a review surface shows for a clip. */
export interface ShapeVideo {
  readonly exportId: string;
}

/** Pins for `videos`, limited to `shapes` when given (a client sees one). */
export function pinVideos(
  videos: ReadonlyMap<VideoShape, ShapeVideo>,
  shapes?: readonly VideoShape[],
): VideoPins {
  const pins: Partial<Record<VideoShape, string>> = {};
  for (const shape of VIDEO_SHAPES) {
    if (shapes !== undefined && !shapes.includes(shape)) continue;
    const video = videos.get(shape);
    // eslint-disable-next-line security/detect-object-injection -- a closed union key
    if (video !== undefined) pins[shape] = video.exportId;
  }
  return pins;
}

export function samePins(a: VideoPins, b: VideoPins): boolean {
  return VIDEO_SHAPES.every((shape) => a[shape] === b[shape]); // eslint-disable-line security/detect-object-injection -- closed union keys
}

/** Pinned shapes whose video has since been replaced by a different one. */
export function replacedShapes(
  pins: VideoPins,
  videos: ReadonlyMap<VideoShape, ShapeVideo>,
): VideoShape[] {
  return VIDEO_SHAPES.filter((shape) => {
    // eslint-disable-next-line security/detect-object-injection -- a closed union key
    const pinned = pins[shape];
    const now = videos.get(shape);
    return pinned !== undefined && now !== undefined && now.exportId !== pinned;
  });
}

/** Shapes with a video the decision was not made on: made after it, or never seen. */
export function uncoveredShapes(
  pins: VideoPins,
  videos: ReadonlyMap<VideoShape, ShapeVideo>,
): VideoShape[] {
  // eslint-disable-next-line security/detect-object-injection -- a closed union key
  return VIDEO_SHAPES.filter((shape) => videos.has(shape) && pins[shape] === undefined);
}

/** Pinned shapes whose pinned video is still the current one. */
export function coveredShapes(
  pins: VideoPins,
  videos: ReadonlyMap<VideoShape, ShapeVideo>,
): VideoShape[] {
  return VIDEO_SHAPES.filter(
    // eslint-disable-next-line security/detect-object-injection -- a closed union key
    (shape) => pins[shape] !== undefined && videos.get(shape)?.exportId === pins[shape],
  );
}

/**
 * When a stored decision no longer stands: a pinned shape has a new video.
 * `null` while it stands (or there is nothing to reopen). A pinned video that
 * is simply gone (its file expired) is not a new video, and reopens nothing:
 * with no file it cannot be posted either.
 */
export function reopenedBy(
  review: { readonly state: ReviewState; readonly videos: unknown } | null,
  videos: ReadonlyMap<VideoShape, ShapeVideo>,
): VideoShape[] | null {
  if (review === null || review.state === "pending") return null;
  const replaced = replacedShapes(pinsOf(review.videos), videos);
  return replaced.length === 0 ? null : replaced;
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * The member rule (the brief's, with viewers settled):
 *
 *   * **approve** - owner or admin. Approval is what lets a clip out when the
 *     workspace requires it, so it sits with the roles that answer for the
 *     workspace. For the same reason only they make client links: a link lets
 *     its client approve, so an editor making one could approve through it.
 *   * **request changes** - editor and up. It holds a clip back (and pulls an
 *     approval), so it takes someone who can do the work it asks for.
 *   * **comment** - everyone, viewers included. A viewer seat is usually the
 *     person whose opinion the review is for (a client contact, a manager); a
 *     comment changes no clip, post or approval, and it would be odd for a
 *     client without an account to be able to say something a signed-in viewer
 *     could not. An editor turns it into a request when it needs one.
 *   * **resolve** - editors and up resolve any comment; anyone their own.
 *   * **revoke a client link** - editor and up: it only ever takes access away.
 */
export interface ReviewPermissions {
  readonly approve: boolean;
  readonly requestChanges: boolean;
  readonly comment: boolean;
  readonly resolveAny: boolean;
  readonly shareLinks: boolean;
  readonly revokeLinks: boolean;
}

export function reviewPermissions(role: $Enums.MembershipRole): ReviewPermissions {
  return {
    approve: roleAtLeast(role, "admin"),
    requestChanges: roleAtLeast(role, "editor"),
    comment: roleAtLeast(role, "viewer"),
    resolveAny: roleAtLeast(role, "editor"),
    shareLinks: roleAtLeast(role, "admin"),
    revokeLinks: roleAtLeast(role, "editor"),
  };
}

export function mayDecide(role: $Enums.MembershipRole, decision: ReviewDecision): boolean {
  const permissions = reviewPermissions(role);
  return decision === "approved" ? permissions.approve : permissions.requestChanges;
}

export function mayResolve(
  role: $Enums.MembershipRole,
  comment: { readonly authorKind: ActorKind; readonly authorUserId: string | null },
  userId: string,
): boolean {
  return (
    reviewPermissions(role).resolveAny ||
    (comment.authorKind === "member" && comment.authorUserId === userId)
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Who is deciding: a member by user id, or a client by the link they came through. */
export type ReviewActor =
  | { readonly kind: "member"; readonly userId: string }
  | { readonly kind: "client"; readonly linkId: string; readonly name: string | null };

/** The stored decision a new one is weighed against. */
export interface StoredReview {
  readonly state: ReviewState;
  readonly actorKind: ActorKind;
  readonly actorUserId: string | null;
  readonly reviewLinkId: string | null;
  readonly actorName: string | null;
  readonly videos: unknown;
}

export type DecisionOutcome =
  | { readonly kind: "no_video" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "write"; readonly state: ReviewDecision; readonly videos: VideoPins };

function sameActor(review: StoredReview, actor: ReviewActor): boolean {
  return actor.kind === "member"
    ? review.actorKind === "member" && review.actorUserId === actor.userId
    : review.actorKind === "client" &&
        review.reviewLinkId === actor.linkId &&
        review.actorName === actor.name;
}

/**
 * What a decision does. An approval needs a video to approve (`no_video`); the
 * same person repeating the same decision on the same videos, with nothing to
 * add, changes nothing (`unchanged`: a double tap is one event). Anything else
 * is written: a new decision, a new decider, new videos ("approve the new ones
 * too"), or a request for changes that says something more.
 */
export function decide(
  current: StoredReview | null,
  input: {
    readonly decision: ReviewDecision;
    readonly actor: ReviewActor;
    readonly videos: VideoPins;
    readonly note?: string | undefined;
  },
): DecisionOutcome {
  if (input.decision === "approved" && Object.keys(input.videos).length === 0) {
    return { kind: "no_video" };
  }
  const hasNote = input.note !== undefined && input.note.trim() !== "";
  if (
    current !== null &&
    current.state === input.decision &&
    !hasNote &&
    sameActor(current, input.actor) &&
    samePins(pinsOf(current.videos), input.videos)
  ) {
    return { kind: "unchanged" };
  }
  return { kind: "write", state: input.decision, videos: input.videos };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** What posting needs to know about one clip's approval. */
export interface ApprovalCheck {
  /** The workspace requires approval before posting. */
  readonly required: boolean;
  readonly state: ReviewState;
  /** Export ids the approval covers; empty unless approved. */
  readonly covered: ReadonlySet<string>;
  /** Why it cannot be posted as it stands, or null when it can (or nothing is required). */
  readonly message: string | null;
}

export const NOT_REQUIRED: ApprovalCheck = Object.freeze({
  required: false,
  state: "pending",
  covered: new Set<string>(),
  message: null,
});

export const APPROVAL_MESSAGES = Object.freeze({
  pending:
    "This clip needs approval before it is posted. An owner or admin approves it on its run.",
  changes_requested:
    "Changes were requested on this clip. It needs approval again before it is posted.",
  changed:
    "This clip's video changed after it was approved. It needs approval again before it is posted.",
  retry:
    "This post was made from a version of the clip that is no longer approved. Post the clip again once it is approved.",
});

export function approvalCheck(
  required: boolean,
  review: { readonly state: ReviewState; readonly videos: unknown } | null,
): ApprovalCheck {
  if (!required) return NOT_REQUIRED;
  const state = review?.state ?? "pending";
  const covered =
    state === "approved" ? new Set(Object.values(pinsOf(review?.videos))) : new Set<string>();
  return {
    required,
    state,
    covered,
    message:
      state === "approved"
        ? null
        : state === "changes_requested"
          ? APPROVAL_MESSAGES.changes_requested
          : APPROVAL_MESSAGES.pending,
  };
}

/** Whether `exportId` may be posted under `check`. */
export function mayPost(check: ApprovalCheck, exportId: string): boolean {
  return !check.required || (check.state === "approved" && check.covered.has(exportId));
}

/** The shapes a stored decision pinned, in shape order. */
export function pinnedShapes(value: unknown): VideoShape[] {
  const pins = pinsOf(value);
  // eslint-disable-next-line security/detect-object-injection -- a closed union key
  return VIDEO_SHAPES.filter((shape) => pins[shape] !== undefined);
}
