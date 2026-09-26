/**
 * Every sentence the guided repurposing flow shows, in one place (REP-007).
 *
 * Two reasons it is a module rather than strings scattered through components:
 *
 *   * a safe error code has to map to exactly one sentence and one recommended
 *     action, and that mapping is a product decision, not a rendering detail
 *     (master plan §3.4, §13.4);
 *   * `copy.test.ts` can then sweep the WHOLE dictionary for technical words, so
 *     "the render queue failed" cannot reach a person through a branch nobody
 *     thought to test.
 */

export interface SafeErrorCopy {
  /** What happened, in plain language. */
  readonly title: string;
  /** Whether their work survived — always answered, never implied. */
  readonly reassurance: string;
  /**
   * The one recommended action:
   *
   *   * `retry` — run the failed step again, same video (`POST .../retry`);
   *   * `choose_another` — this video cannot work; start again with another,
   *     keeping the caption setup;
   *   * `edit_settings` — the link or a setting needs fixing; start again with
   *     the same link AND setup pre-filled so it can be corrected;
   *   * `add_moment` — pick the moment by its start and end time instead;
   *   * `open_existing` — the work already exists in another run;
   *   * `check_credits` — the balance is the problem: see it (`/billing`),
   *     and try again once there is enough;
   *   * `contact_support` — nothing on this page can help.
   */
  readonly action:
    | "retry"
    | "choose_another"
    | "edit_settings"
    | "add_moment"
    | "open_existing"
    | "check_credits"
    | "contact_support";
  readonly actionLabel: string;
}

/** Nothing was fetched, so nothing was charged: said on every "pick another" card. */
const NOTHING_SPENT = "Nothing was lost, and no credits were used.";

const HIGHLIGHTS_FAILED: SafeErrorCopy = {
  title: "We could not finish finding moments",
  reassurance: "Your video and its transcript are safe.",
  action: "retry",
  actionLabel: "Try again",
};

const CLIP_FAILED: SafeErrorCopy = {
  title: "We could not make one of your clips",
  reassurance: "Your video, its transcript and your other clips are safe.",
  action: "retry",
  actionLabel: "Try again",
};

/**
 * Safe error codes: every entry of `SAFE_ERROR_CODES` in
 * `@montaj/repurpose-contracts` (`copy.test.ts` holds the two lists together),
 * plus two codes older runs still carry.
 *
 * `unknown` is the catch-all: an error code this build has never heard of still
 * has to produce a sentence, because the alternative is rendering the raw code.
 */
export const SAFE_ERROR_COPY: Readonly<Record<string, SafeErrorCopy>> = Object.freeze({
  "repurpose/source_invalid_url": {
    title: "That link did not work",
    reassurance: "Nothing was lost — nothing has started yet.",
    action: "edit_settings",
    actionLabel: "Check the link",
  },
  "repurpose/source_rights_required": {
    title: "We need your confirmation first",
    reassurance: "Nothing was lost — nothing has started yet.",
    action: "edit_settings",
    actionLabel: "Confirm and continue",
  },
  "repurpose/source_unsupported": {
    title: "We cannot use that link",
    reassurance: "Nothing was lost — nothing has started yet.",
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  "repurpose/source_already_running": {
    title: "You are already working on this video",
    reassurance: "Your existing work is safe and still running.",
    action: "open_existing",
    actionLabel: "Open the existing run",
  },
  // A download that failed for a reason nobody could name. Usually a hiccup on
  // the site's side, so the same link is worth one more go.
  "repurpose/source_unavailable": {
    title: "We could not get that video",
    reassurance: "Everything you had before is still here. It may work if you try again.",
    action: "retry",
    actionLabel: "Try again",
  },
  "repurpose/source_too_large": {
    title: "This video is bigger than your plan allows",
    reassurance: `${NOTHING_SPENT} A shorter video, or a smaller copy you upload, will fit.`,
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  // The plan's own limit lives on the server; the page only knows it was over.
  "repurpose/source_too_long": {
    title: "This video is longer than your plan allows",
    reassurance: `${NOTHING_SPENT} A shorter video, or a trimmed copy you upload, will fit.`,
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  "repurpose/source_private": {
    title: "That video is private",
    reassurance: `${NOTHING_SPENT} We can only use videos anyone can watch without signing in.`,
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  "repurpose/source_age_restricted": {
    title: "That video is age-restricted",
    reassurance: `${NOTHING_SPENT} YouTube only shows it to signed-in viewers, so we cannot use it.`,
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  "repurpose/source_live": {
    title: "That video is still live",
    reassurance: `${NOTHING_SPENT} A live stream can be used once it has ended and YouTube has saved it.`,
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  "repurpose/source_removed": {
    title: "That video is no longer on YouTube",
    reassurance: `${NOTHING_SPENT} It may have been deleted or taken down.`,
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  // The one download failure where the SAME link is the right next step: the
  // site is turning this server away for a while, and it passes.
  "repurpose/source_blocked": {
    title: "YouTube is refusing our server for a few minutes",
    reassurance: "Your link is fine and nothing was lost. Try again in a few minutes.",
    action: "retry",
    actionLabel: "Try again",
  },
  "repurpose/source_playlist": {
    title: "That link is a playlist, not one video",
    reassurance: `${NOTHING_SPENT} Open the video you want and copy its own link.`,
    action: "edit_settings",
    actionLabel: "Check the link",
  },
  "repurpose/processing_failed": {
    title: "We could not prepare that video",
    reassurance: "We got the video but could not read it. Nothing else was affected.",
    action: "retry",
    actionLabel: "Try again",
  },
  "repurpose/transcription_failed": {
    title: "We could not create the transcript",
    reassurance: "Your video is safe.",
    action: "retry",
    actionLabel: "Try again",
  },
  // "Try again" alone only fails the same way, and this card used to send
  // people to Billing to add credits — which cannot be bought while checkout is
  // off. The balance is what can be checked; trying again stays on the card
  // for once there is enough.
  "repurpose/no_credits": {
    title: "You are out of credits for this video",
    reassurance:
      "Your video is safe. Making its transcript needs more credits than you have left right now. Try again once you have enough.",
    action: "check_credits",
    actionLabel: "See your credits",
  },
  "repurpose/highlights_failed": HIGHLIGHTS_FAILED,
  // What the API wrote before 2026-09-26 for the same failure.
  "repurpose/analysis_failed": HIGHLIGHTS_FAILED,
  "repurpose/highlights_no_candidates": {
    title: "We could not find a strong moment in this video",
    reassurance: "Your video is safe. You can still pick the exact times yourself.",
    action: "add_moment",
    actionLabel: "Add a moment by time",
  },
  "repurpose/stage_timeout": {
    title: "This step took too long",
    reassurance: "Your work is safe. Trying again starts the step afresh.",
    action: "retry",
    actionLabel: "Try again",
  },
  // Older runs only: a clip's failure is the clip's own now, never the run's.
  "repurpose/clip_failed": CLIP_FAILED,
  "repurpose/clip_bounds_invalid": {
    title: "Those start and end times do not work",
    reassurance: "Nothing else changed.",
    action: "edit_settings",
    actionLabel: "Adjust the times",
  },
  "repurpose/variant_stale": {
    title: "This video changed after it was approved",
    reassurance: "The new version is safe; it just needs another look.",
    action: "edit_settings",
    actionLabel: "Review it again",
  },
  unknown: {
    title: "Something went wrong",
    reassurance: "Your work is safe.",
    action: "retry",
    actionLabel: "Try again",
  },
});

export function safeErrorCopy(code: string | null): SafeErrorCopy {
  if (code === null) return SAFE_ERROR_COPY["unknown"] as SafeErrorCopy;
  // eslint-disable-next-line security/detect-object-injection -- a miss falls back to the "unknown" entry, which is the point
  return (SAFE_ERROR_COPY[code] ?? SAFE_ERROR_COPY["unknown"]) as SafeErrorCopy;
}

/**
 * What one clip's row says while it is not yet a picture (the run page).
 *
 * `waiting` is the plan's lane being full, which is not an error: the cut is
 * already booked and starts by itself, so the sentence says so rather than
 * offering a button that would only book it twice.
 */
export const CLIP_STATE_COPY = Object.freeze({
  waiting: "Waiting for a free slot — it starts on its own.",
  cutting: "Cutting the 9:16 clip…",
  unavailable: "This clip is ready, but its preview did not load. Refresh the page to see it.",
  // A stopped run starts nothing new: a clip still waiting for a slot never
  // gets one, and a failed one cannot be cut again from this run.
  stopped: "Not made — this run was stopped before it started.",
  stoppedFailed:
    "Your video and your other clips are safe. This run was stopped, so this clip cannot be tried again here.",
});

export interface ClipFailureCopy {
  readonly title: string;
  readonly reassurance: string;
  /**
   * Whether cutting it again can work. Not when the original video is gone:
   * the retry would only be refused, so the card offers a new run instead.
   */
  readonly retryable: boolean;
}

/** The original video is no longer stored, so nothing can be cut from it again. */
const CLIP_SOURCE_GONE: ClipFailureCopy = {
  title: "The original video is no longer kept",
  reassurance: "Your other clips are safe. To cut this moment, start again from the same link.",
  retryable: false,
};

/**
 * A failed clip, by the code of its newest cut (`failureCode` on the clip: the
 * `media.clip` job's own code, or the API's `repurpose/source_expired`). A
 * clip's failure is its own: every entry says the other clips are untouched.
 */
export const CLIP_FAILURE_COPY: Readonly<Record<string, ClipFailureCopy>> = Object.freeze({
  "media/unreadable": {
    title: "We could not read this part of the video",
    reassurance: "Your video and your other clips are safe. Trying again often works.",
    retryable: true,
  },
  "media/corrupt": {
    title: "We could not read this part of the video",
    reassurance: "Your video and your other clips are safe. Trying again often works.",
    retryable: true,
  },
  "media/source_unavailable": {
    title: "We could not reach your video just then",
    reassurance: "Your video and your other clips are safe. Trying again usually works.",
    retryable: true,
  },
  "media/encode_failed": {
    title: "We could not finish cutting this clip",
    reassurance: "Your video and your other clips are safe. Trying again usually works.",
    retryable: true,
  },
  "media/encode_incomplete": {
    title: "We could not finish cutting this clip",
    reassurance: "Your video and your other clips are safe. Trying again usually works.",
    retryable: true,
  },
  "jobs/queue_timeout": {
    title: "This clip waited too long to start",
    reassurance:
      "Your video and your other clips are safe. Try again once your other videos are done.",
    retryable: true,
  },
  "jobs/cancelled": {
    title: "This clip was stopped before it finished",
    reassurance: "Your video and your other clips are safe.",
    retryable: true,
  },
  "media/source_missing": CLIP_SOURCE_GONE,
  "repurpose/source_expired": CLIP_SOURCE_GONE,
  unknown: {
    title: "This clip could not be made",
    reassurance: "Your video and your other clips are safe.",
    retryable: true,
  },
});

export function clipFailureCopy(code: string | null | undefined): ClipFailureCopy {
  const fallback = CLIP_FAILURE_COPY["unknown"] as ClipFailureCopy;
  if (code === null || code === undefined) return fallback;
  // eslint-disable-next-line security/detect-object-injection -- a miss falls back to the "unknown" entry
  return CLIP_FAILURE_COPY[code] ?? fallback;
}

/**
 * One sentence for each way a request on these pages can be refused.
 *
 * The API's own `message` is never shown: for its own `repurpose/*` codes it is
 * usually fine, but the same request can also be refused by admission ("the
 * free plan allows 2 jobs in flight"), by the job ledger ("the job queue is
 * unavailable") or by the idempotency layer, none of which were written for a
 * person. So a code maps to a sentence here, and anything unmapped gets the
 * context's plain fallback.
 */
export const REFUSAL_COPY = Object.freeze({
  /** The start form. */
  start: {
    "repurpose/source_invalid_url": "That link did not work. Paste the link to one YouTube video.",
    "repurpose/source_unsupported":
      "We can only use YouTube links here. For a video from anywhere else, upload the file.",
    "repurpose/source_rights_required":
      "Please confirm you own this video or have permission to use it.",
    "repurpose/source_already_running": "You are already working on this video.",
    "repurpose/style_unknown": "That caption look is no longer available. Choose another one.",
    "repurpose/not_available": "The clips pipeline is not on for this workspace yet.",
    // Trying the same form again cannot help, so the sentence does not say to.
    "common/validation_failed":
      "Something in the form was not accepted. Check the link and your choices.",
    busy: "Your other videos are still being prepared. Try again in about a minute.",
    "common/rate_limited": "That was a lot of requests at once. Wait a moment, then try again.",
    network: "The run could not be started. Check your connection and try again.",
    fallback: "The run could not be started. Try again in a moment.",
  },
  /** "Create 9:16 clip" and a clip's "Try again". */
  clip: {
    // From a moment's own card the run has moments, so this refusal means the
    // run was stopped (in another tab, say) — not "it has no moments yet".
    "repurpose/run_not_ready": "This run was stopped, so no new clips can be made from it.",
    "repurpose/not_found": "That moment is no longer available. Refresh the page.",
    // A second tab (or the page's own poll) got there first.
    "repurpose/clip_not_retryable": "This clip is already being made. Refresh the page to see it.",
    "repurpose/source_expired":
      "The original video is no longer kept, so new clips cannot be cut from it. Start again from the same link.",
    "repurpose/clip_limit": "This run already has as many clips as it can hold.",
    busy: "You have other clips being made. Try again in a moment.",
    "common/rate_limited": "That was a lot of requests at once. Wait a moment, then try again.",
    network: "We could not reach the server. Check your connection and try again.",
    fallback: "That clip could not be started. Try again in a moment.",
  },
  /** "Add a moment by time". */
  moment: {
    "repurpose/clip_bounds_invalid":
      "Those times do not work. A moment is 3 seconds to 3 minutes long, inside the video.",
    "repurpose/run_not_ready": "You can add moments once the transcript is ready.",
    "repurpose/clip_limit": "This run already has as many of your own moments as it can hold.",
    "common/rate_limited": "That was a lot of requests at once. Wait a moment, then try again.",
    network: "We could not reach the server. Check your connection and try again.",
    fallback: "That moment could not be added. Try again in a moment.",
  },
  /** A failed run's "Try again". */
  retry: {
    "repurpose/not_retryable": "This run cannot be tried again. Start a new run instead.",
    "repurpose/source_already_running": "You are already working on this video in another run.",
    busy: "Your other videos are still being prepared. Try again in about a minute.",
    "common/rate_limited": "That was a lot of requests at once. Wait a moment, then try again.",
    network: "We could not reach the server. Check your connection and try again.",
    fallback: "That did not work. Try again in a moment.",
  },
} satisfies Record<string, Record<string, string> & { network: string; fallback: string }>);

export type RefusalContext = keyof typeof REFUSAL_COPY;

/** Headings and helper text for the five stages (§3.2). */
export const STAGE_COPY = Object.freeze({
  getting_video: {
    title: "Add video",
    helper: "Paste a link or choose a video from your device.",
  },
  finding_clips: {
    title: "Find clips",
    helper: "We'll understand the video and suggest its strongest moments.",
  },
  styles_formats: {
    title: "Style formats",
    helper: "Choose the looks and sizes you want to publish.",
  },
  review: {
    title: "Review",
    helper: "Preview each video and make any final changes.",
  },
  publish: {
    title: "Publish",
    helper: "Choose accounts, post now, or schedule for later.",
  },
});

export type StageKey = keyof typeof STAGE_COPY;

/** The reassurance shown under an in-progress run (§3.4). */
export const BACKGROUND_NOTE = "You can leave this page — we'll keep working.";

/**
 * Words that must never reach a person (§13.4), and the sweep that finds them.
 *
 * The same list the API keeps, because the rule is about the product, not about
 * one runtime. Duplicating eight strings is cheaper than making the web bundle
 * import a server module.
 */
export const FORBIDDEN_USER_FACING_WORDS = [
  "montaj",
  "postiz",
  "queue",
  "worker",
  "webhook",
  "ffmpeg",
  "manifest",
  "edg",
  "bullmq",
  "prisma",
  "redis",
  "stack trace",
] as const;

export function beginnerSafetyViolations(text: string): string[] {
  const haystack = text.toLowerCase();
  return FORBIDDEN_USER_FACING_WORDS.filter((word) => haystack.includes(word));
}
