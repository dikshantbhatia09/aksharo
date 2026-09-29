/**
 * Every sentence clip review says (2026-10-03), on the run page, in the share
 * dialog, in settings and on the client's review page, in one place so the
 * beginner-safety sweep (`beginnerSafetyViolations`: no tool names, no
 * "queue") covers all of it.
 */
import { isApiError } from "@montaj/api-client";

import type { ReviewActor, ReviewShape, ReviewState } from "./use-review";

export const REVIEW_STATE_LABEL: Readonly<Record<ReviewState, string>> = Object.freeze({
  pending: "Waiting for review",
  approved: "Approved",
  changes_requested: "Changes requested",
});

export const REVIEW_COPY = Object.freeze({
  heading: "Review",
  needsApproval: "Needs approval before it can be posted.",
  backInReview: "Back in review: its video changed after the last decision.",
  approve: "Approve",
  approving: "Approving…",
  approveAlso: "Approve these too",
  requestChanges: "Request changes",
  requestChangesLabel: "What should change?",
  requestChangesHint: "The team sees this with the request, in the clip's comments.",
  send: "Send",
  sending: "Sending…",
  cancel: "Cancel",
  comments: (total: number, open: number): string =>
    total === 0
      ? "Comment"
      : open === total
        ? `Comments (${String(total)})`
        : `Comments (${String(open)} open of ${String(total)})`,
  hideComments: "Hide comments",
  commentsHeading: "Comments",
  noComments: "No comments yet.",
  commentLabel: "Add a comment",
  commentPlaceholder: "What works, and what should change?",
  atTime: (time: string): string => `At ${time} in the clip`,
  postComment: "Post comment",
  posting: "Posting…",
  resolve: "Resolve",
  reopen: "Reopen",
  resolved: "Resolved",
  historyHeading: "History",
  seek: (time: string): string => `Play from ${time}`,
  noVideoAutopilot: "It can be approved once its video with captions is made.",
  noVideoManual:
    "Export this clip from the editor to approve it: an approval covers the video that is posted.",
  videoLabel: (title: string): string => `${title}, the video under review`,
  formerMember: "A former member",
  aksharo: "Aksharo",
  clientPrefix: "Client",
  anonymousClient: "A client",
});

/** "vertical (9:16)", "square (1:1)" ... as a sentence names a shape. */
export function shapeWords(shape: ReviewShape): string {
  switch (shape) {
    case "9:16":
      return "vertical (9:16)";
    case "4:5":
      return "4:5";
    case "1:1":
      return "square (1:1)";
    case "16:9":
      return "wide (16:9)";
  }
}

/** "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

/** The approval covers some shapes; others were made after it. */
export function uncoveredNote(shapes: readonly ReviewShape[]): string {
  const names = listWords(shapes.map(shapeWords));
  return shapes.length === 1
    ? `The ${names} video was made after this approval. It is not posted until it is approved too.`
    : `The ${names} videos were made after this approval. They are not posted until they are approved too.`;
}

/** Who a decision or comment is from, as the team reads it. */
export function actorName(actor: ReviewActor): string {
  switch (actor.kind) {
    case "system":
      return REVIEW_COPY.aksharo;
    case "client":
      return actor.name === null || actor.name.trim() === ""
        ? REVIEW_COPY.anonymousClient
        : `${REVIEW_COPY.clientPrefix}: ${actor.name}`;
    case "member":
      return actor.name ?? REVIEW_COPY.formerMember;
  }
}

/** "0:12" from 12 000 ms. */
export function clipClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

/** "5 minutes ago", "yesterday". */
export function sinceWords(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** The client links' dialog and list. */
export const SHARE_COPY = Object.freeze({
  button: "Share for review",
  title: "Share clips for review",
  description:
    "Anyone with the link can watch this run's finished clips on their phone, approve them or ask for changes. No account needed.",
  expiresLabel: "Link works for",
  days: (days: number): string => (days === 1 ? "1 day" : `${String(days)} days`),
  requireName: "Ask for the reviewer's name",
  requireNameHint: "They give it before they approve or comment, so you know who said what.",
  labelLabel: "Name this link (only your team sees it)",
  labelPlaceholder: "For Priya at Acme",
  create: "Create link",
  creating: "Creating…",
  created: "Copy the link now. For safety it is shown only once.",
  copy: "Copy link",
  copied: "Copied",
  shareNative: "Share",
  done: "Done",
  linksHeading: "Links",
  noLinks: "No review links yet.",
  status: Object.freeze({ live: "Works", expired: "Expired", revoked: "Turned off" }),
  until: (date: string): string => `until ${date}`,
  visits: (count: number): string =>
    count === 1 ? "opened once" : `opened ${String(count)} times`,
  never: "not opened yet",
  said: (decisions: number, comments: number): string =>
    `${String(decisions)} ${decisions === 1 ? "decision" : "decisions"}, ${String(comments)} ${comments === 1 ? "comment" : "comments"}`,
  revoke: "Turn off",
  revokeTitle: "Turn off this review link?",
  revokeDescription:
    "It stops opening at once, for everyone who has it. What was already said through it stays.",
  adminOnly: "Only an owner or admin can share clips for review: a client's approval counts.",
  offline: "Sharing for review is not available here yet.",
});

/** Settings: the approval switch. */
export const APPROVAL_SETTING_COPY = Object.freeze({
  title: "Approval",
  description: "Decide whether clips need a sign-off before they go out.",
  label: "Clips need approval before posting",
  hint: "When this is on, a clip is posted only after an owner or admin (or a client with a review link) approves it, and only the version that was approved.",
  on: "Clips now need approval before posting.",
  off: "Clips can be posted without approval.",
  adminOnly: "Only an owner or admin can change this.",
});

/** Sentences for the API's `review/*` refusals. */
const REFUSAL: Readonly<Record<string, string>> = Object.freeze({
  "review/clip_not_found": "That clip is no longer here.",
  "review/comment_not_found": "That comment is no longer here.",
  "review/link_not_found": "That review link is no longer here.",
  "repurpose/not_available": "This is not available yet.",
  "repurpose/not_found": "We could not find that video project.",
  "common/rate_limited": "That is a lot at once. Wait a minute and try again.",
  "common/forbidden": "Your role does not allow this.",
});

/**
 * One sentence for a refused request. The API's own message is used for the
 * refusals it writes for people (who may decide, what changed), and a fixed
 * sentence for the rest.
 */
export function describeReviewError(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return "We could not reach Aksharo. Check your connection and try again.";
  }
  const specific = new Set([
    "review/forbidden",
    "review/no_video",
    "review/video_changed",
    "review/busy",
    "review/too_many_links",
    "review/name_required",
    "review/link_revoked",
    "review/link_expired",
  ]);
  if (specific.has(error.code) && error.message.trim() !== "") return error.message;
  return REFUSAL[error.code] ?? "That did not work. Try again.";
}
