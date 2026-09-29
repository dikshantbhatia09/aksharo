/**
 * The Automations page's words (2026-10-02), in one place so the sweep in
 * `automations.test.tsx` covers them (`beginnerSafetyViolations`): no queue,
 * no worker, no feed - a person connects a channel, and its new videos become
 * clips.
 */
import { isApiError } from "@montaj/api-client";

import type { WatchStateReason, WatchVideo } from "./use-automations";

export const AUTOMATIONS_COPY = Object.freeze({
  eyebrow: "Clips pipeline",
  title: "Automations",
  description:
    "Connect a YouTube channel once. Every new video it publishes becomes clips on Autopilot, with the settings you choose here.",
  runsLink: "Your runs",
  off: {
    title: "Automations are not on for this workspace yet",
    description:
      "They turn every new video from a YouTube channel into clips by themselves. You will be told here when they reach your workspace.",
  },
  checksOff:
    "New videos are not being picked up on this server right now. Your automations are kept and start again as soon as checks are back on.",
  loadError: "Your automations could not be loaded. Refresh the page to try again.",
  readOnly:
    "Editors of this workspace connect channels and change automations. You can see what each one is doing.",
  add: {
    heading: "Connect a channel",
    linkLabel: "Channel link",
    linkHint: "Like youtube.com/@yourchannel. The channel, not one of its videos.",
    linkPlaceholder: "https://www.youtube.com/@yourchannel",
    find: "Find channel",
    finding: "Finding…",
    linkRequired: "Paste the link to a YouTube channel.",
    linkInvalid: "Paste a channel link, like youtube.com/@yourchannel or youtube.com/channel/UC….",
    alreadyFollowed: "This workspace already follows this channel.",
    backfillLegend: "Also make clips of its latest videos?",
    backfillHint: "New videos are always picked up. These are ones it already published.",
    backfill: (count: number): string =>
      count === 0
        ? "Only new videos"
        : count === 1
          ? "The latest one"
          : `The latest ${String(count)}`,
    rights: "I own this channel or have permission to use its videos.",
    rightsRequired: "Please confirm you own this channel or have permission to use its videos.",
    save: "Save automation",
    saving: "Saving…",
    saved: (title: string): string =>
      `${title} is connected. Its next video starts on its own, usually within an hour of going up.`,
    limit: (max: number): string =>
      `A workspace can follow up to ${String(max)} channels. Remove one to add another.`,
  },
  list: {
    heading: "Your automations",
    emptyTitle: "No automations yet",
    emptyDescription: "Connect a channel above, and its next video starts on its own.",
    state: { active: "Active", paused: "Paused", error: "Needs attention" },
    checked: (when: string): string => `Checked ${when}`,
    notChecked: "Not checked yet",
    nextCheck: (when: string): string => `next look ${when}`,
    runs: (count: number): string =>
      count === 1 ? "1 run started" : `${String(count)} runs started`,
    readFailed: "We could not read this channel at the last check. We will try again.",
    notFound: "YouTube could not find this channel at the last check. We will try again.",
    videosHeading: "Recent videos",
    open: "Open",
    pause: "Pause",
    resume: "Resume",
    edit: "Edit settings",
    remove: "Remove",
    removeTitle: (title: string): string => `Stop following ${title}?`,
    removeDescription:
      "Its new videos will no longer become clips. Runs it already started stay in your runs.",
    removeConfirm: "Remove automation",
    saveChanges: "Save changes",
    savingChanges: "Saving…",
    cancel: "Cancel",
    settingsNote: "Changes apply to its next videos. Runs already started keep their settings.",
  },
});

/** What one of a watch's videos is doing, in words. */
export function videoStateText(video: Pick<WatchVideo, "state" | "reason">): string {
  switch (video.state) {
    case "pending":
      return "Waiting to start";
    case "starting":
      return "Starting";
    case "started":
      return video.reason === "already_running" ? "Already running" : "Clips on the way";
    case "skipped":
      return video.reason === "short"
        ? "A Short, skipped"
        : video.reason === "upcoming"
          ? "Never went live, skipped"
          : video.reason === "too_old"
            ? "Found too late, skipped"
            : "Skipped";
    case "failed":
      return "Could not start";
  }
}

/** A paused watch's one line when the API sent none. */
export const STATE_REASON_FALLBACK: Readonly<Record<WatchStateReason, string>> = Object.freeze({
  person: "Paused. New videos are not picked up until you resume it.",
  no_credits: "Paused: out of credits. Add credits, then resume it.",
  creator_left:
    "Paused: the person who set this up is no longer an editor here. Remove it and connect the channel again.",
  style_unknown: "Paused: choose another caption look in its settings, then resume it.",
  setup_invalid: "Paused: save its settings again, then resume it.",
  channel_not_found: "This channel could not be found on YouTube.",
});

/** Refusals on this page, by code, in the page's words. */
const REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  "repurpose/channel_url_invalid": AUTOMATIONS_COPY.add.linkInvalid,
  "repurpose/channel_not_found": "We could not find that channel on YouTube. Check the link.",
  "repurpose/youtube_busy":
    "YouTube is not answering us right now. Try again in a while; nothing was lost.",
  "repurpose/channel_unreadable": "We could not read that channel just now. Try again in a minute.",
  "repurpose/watch_exists": AUTOMATIONS_COPY.add.alreadyFollowed,
  "repurpose/watch_limit": AUTOMATIONS_COPY.add.limit(20),
  "repurpose/style_unknown": "That caption look is no longer available. Choose another one.",
  "repurpose/watch_creator_gone":
    "The person who set this up is no longer an editor here. Remove it and connect the channel again.",
  "repurpose/automations_not_available": AUTOMATIONS_COPY.off.title,
  "repurpose/watch_not_found": "That automation no longer exists. Refresh the page.",
  "common/validation_failed": "Something in the settings was not accepted. Check your choices.",
  "common/rate_limited": "That was a lot of requests at once. Wait a moment, then try again.",
  network: "We could not reach the server. Check your connection and try again.",
  fallback: "That did not work. Try again in a moment.",
});

/** A refused request on this page as the one sentence it may show - never the API's own words. */
export function automationRefusal(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) return REFUSALS["network"] ?? "";

  return REFUSALS[error.code] ?? REFUSALS["fallback"] ?? "";
}

/** Every sentence above, for the sweep. */
export function allAutomationsCopy(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") out.push(String((value as (n: number) => string)(2)));
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(AUTOMATIONS_COPY);
  walk(STATE_REASON_FALLBACK);
  walk(REFUSALS);
  for (const state of ["pending", "starting", "started", "skipped", "failed"] as const) {
    for (const reason of [null, "short", "upcoming", "too_old", "already_running"]) {
      out.push(videoStateText({ state, reason }));
    }
  }
  return out;
}
