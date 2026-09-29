/**
 * Every sentence the run page says about posting (2026-09-29), in one place so
 * the beginner-safety sweep (`FORBIDDEN_USER_FACING_WORDS`: no "Postiz", no
 * "queue", no tool names) covers all of it. The settings page, which is where
 * the owner sets up Postiz itself, may name it; this page may not.
 */
import { isApiError } from "@montaj/api-client";

import type { PostStatus, PublishPost, PublishProvider, UnavailableReason } from "./use-publishing";

export const PUBLISH_COPY = Object.freeze({
  postButton: "Post",
  dialogTitle: "Post this clip",
  dialogDescription: "Choose where it goes and when. Nothing is posted until you confirm.",
  loading: "Finding your accounts…",
  where: "Where",
  noReadyChannel: "None of your accounts can take this clip yet.",
  text: "Text",
  whenLegend: "When",
  whenNow: "Now",
  whenAt: "Pick a time",
  whenDaily: "One a day",
  dailyHint: (time: string): string =>
    `Goes out at ${time} India time, on the next day each account has nothing else posted.`,
  atHint: (zone: string): string => `In your time zone (${zone}).`,
  confirmNow: (count: number): string =>
    count <= 1 ? "Post now" : `Post to ${String(count)} accounts`,
  confirmAt: "Schedule",
  confirmDaily: "Add to one a day",
  sending: "Sending…",
  cancel: "Cancel",
  setUp: "See how to set it up",
  youtubeVisibility: "Who can see it on YouTube",
  tiktokVisibility: "Who can see it on TikTok",
  tiktokNote: "Until your TikTok app is approved, TikTok only allows “Only me”.",
  postsHeading: "Posts",
  retry: "Try again",
  retrying: "Trying again…",
  cancelPost: "Cancel post",
  cancelTitle: "Cancel this post?",
  cancelDescription: "It will not go out. You can post the clip again whenever you like.",
  viewPost: "View post",
  posting: "Posting…",
  posted: "Posted",
  cancelled: "Cancelled",
  dailyButton: "Post one a day",
  dailyTitle: "Post one a day",
  dailyDescription:
    "Each clip goes out on its own day at the time you pick, skipping days an account already has a post.",
  dailyClips: "Clips",
  dailyAccounts: "Accounts",
  dailyTime: "Time (India)",
  dailyConfirm: (count: number): string =>
    count === 1 ? "Schedule 1 clip" : `Schedule ${String(count)} clips`,
  dailyNoClips: "No clip is ready to post yet.",
  needsApproval: "This clip needs approval before it is posted.",
  approveHere: "An owner or admin approves it in the clip's review on this page.",
});

/** Why posting is not available, as one sentence, for the dialog. */
export const UNAVAILABLE_COPY: Readonly<Record<UnavailableReason, string>> = Object.freeze({
  flag_off: "Posting to your accounts is not switched on yet.",
  not_this_workspace: "Posting is set up for another workspace, not this one.",
  not_configured: "Posting to your accounts is not set up yet.",
  unreachable: "The publishing service is not answering right now. Try again in a minute.",
  key_refused: "The publishing service did not accept Aksharo's key.",
  no_channels: "No accounts are connected yet.",
});

/** What each platform's text box is called. */
export const TEXT_LABEL: Readonly<Record<PublishProvider, { body: string; title?: string }>> =
  Object.freeze({
    instagram: { body: "Instagram caption" },
    facebook: { body: "Facebook post" },
    youtube: { title: "YouTube title", body: "YouTube description" },
    tiktok: { title: "TikTok title", body: "TikTok caption" },
    linkedin: { body: "LinkedIn post" },
    x: { body: "X post" },
    threads: { body: "Threads post" },
  });

/** Sentences for the API's `publishing/*` refusals. */
const REFUSAL: Readonly<Record<string, string>> = Object.freeze({
  "publishing/disabled": "Posting to your accounts is not switched on yet.",
  "publishing/not_configured": "Posting to your accounts is not set up yet.",
  "publishing/unavailable":
    "The publishing service is not answering right now. Try again in a minute.",
  "publishing/already_posted":
    "This clip already has a post on one of those accounts at that time. Try again or cancel that one first.",
  "publishing/not_cancellable": "This post cannot be cancelled now.",
  "publishing/not_retryable": "This post cannot be tried again. Post the clip again instead.",
  "publishing/post_not_found": "That post is no longer here.",
  "publishing/clip_not_found": "That clip is no longer here.",
  "common/rate_limited": "That is a lot of posting at once. Wait a minute and try again.",
  "publishing/not_approved": "This clip needs approval before it is posted.",
});

/**
 * One sentence for a refused request. The API's own message is used for the
 * refusals that name a specific account or limit (they are written for people
 * and say which one), and a fixed sentence for the rest.
 */
export function describePublishError(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return "We could not reach Aksharo. Check your connection and try again.";
  }
  const specific = new Set([
    "publishing/already_posted",
    "publishing/not_ready",
    "publishing/text_invalid",
    "publishing/time_invalid",
    "publishing/channel_unknown",
    "publishing/channel_unavailable",
    "publishing/not_cancellable",
    "publishing/not_retryable",
    "publishing/not_approved",
  ]);
  if (specific.has(error.code) && error.message.trim() !== "") return error.message;
  return REFUSAL[error.code] ?? "That did not work. Try again.";
}

/** "Tue 1 Oct, 7:00 pm", in the viewer's zone or a given one. */
export function formatWhen(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
}

/** "7:00 pm" from "19:00". */
export function formatClock(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (
    hours === undefined ||
    minutes === undefined ||
    Number.isNaN(hours) ||
    Number.isNaN(minutes)
  ) {
    return value;
  }
  const date = new Date(Date.UTC(2026, 0, 1, hours, minutes));
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/** One line for a post: where it stands. */
export function postStatusLine(post: PublishPost): string {
  const byStatus: Readonly<Record<PostStatus, () => string>> = {
    posting: () => post.note ?? PUBLISH_COPY.posting,
    scheduled: () =>
      post.scheduledAt === null ? "Scheduled" : `Scheduled for ${formatWhen(post.scheduledAt)}`,
    posted: () =>
      post.publishedAt === null
        ? PUBLISH_COPY.posted
        : `${PUBLISH_COPY.posted} ${formatWhen(post.publishedAt)}`,
    failed: () => `Did not post. ${post.error?.message ?? "Try again."}`,
    cancelled: () =>
      post.note === null ? PUBLISH_COPY.cancelled : `${PUBLISH_COPY.cancelled}. ${post.note}`,
  };

  return byStatus[post.status]();
}

const URL_IN_TEXT = /https?:\/\/\S+/g;

/**
 * Length as the platform counts it: X weighs each link as 23 and most scripts
 * beyond Latin and Indic as two; everywhere else it is characters. The server
 * checks again; this is so the counter and the button agree with it.
 */
export function textLength(value: string, linkLength: number | null): number {
  if (linkLength === null) return [...value].length;
  const links = value.match(URL_IN_TEXT) ?? [];
  let length = links.length * linkLength;
  for (const char of value.replace(URL_IN_TEXT, "")) {
    const code = char.codePointAt(0) ?? 0;
    const light =
      code <= 0x10ff ||
      (code >= 0x2000 && code <= 0x200d) ||
      (code >= 0x2010 && code <= 0x201f) ||
      (code >= 0x2032 && code <= 0x2037);
    length += light ? 1 : 2;
  }
  return length;
}
