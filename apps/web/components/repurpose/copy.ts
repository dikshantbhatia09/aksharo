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
  /** The one recommended action. */
  readonly action: "retry" | "choose_another" | "contact_support" | "edit_settings";
  readonly actionLabel: string;
}

/**
 * Safe error codes, from the API's own list.
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
    action: "choose_another",
    actionLabel: "Open the existing one",
  },
  "repurpose/source_unavailable": {
    title: "We could not get that video",
    reassurance: "Everything you had before is still here.",
    action: "choose_another",
    actionLabel: "Choose another video",
  },
  "repurpose/highlights_failed": {
    title: "We could not finish finding moments",
    reassurance: "Your video and its transcript are safe.",
    action: "retry",
    actionLabel: "Try again",
  },
  "repurpose/highlights_no_candidates": {
    title: "We could not find a strong moment in this video",
    reassurance: "Your video is safe. You can still pick the exact times yourself.",
    action: "edit_settings",
    actionLabel: "Pick times myself",
  },
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
