/**
 * Every sentence the voice-over hook shows (2026-10-01): the "Add a voice-over
 * hook" dialog, a clip's Voice-over row, and what each way one can end means
 * to a person. Plain words: no vendor, no model, no "TTS".
 */
import { isApiError } from "@montaj/api-client";

export const VOICEOVER_COPY = Object.freeze({
  button: "Add a voice-over hook",
  dialogTitle: "Add a voice-over hook",
  dialogDescription: (language: string): string =>
    `A voice reads this line at the start of the clip, in ${language}, with the clip's own sound turned down underneath. It is added to every size of the clip.`,
  textLabel: "What the voice says",
  textHint: (left: number): string =>
    left === 1 ? "1 character left" : `${String(left)} characters left`,
  speakerLabel: "Voice",
  confirm: "Add voice-over",
  confirming: "Starting…",
  cancel: "Cancel",
  section: "Voice-over hook",
  state: Object.freeze({
    waiting: "Waiting for a free slot",
    speaking: "Making the voice-over…",
    ready: "Added",
    failed: "Could not be made",
    removed: "Taken off",
  }),
  placed: (shapes: number): string =>
    shapes === 1 ? "On 1 size of this clip" : `On ${String(shapes)} sizes of this clip`,
  placing: "Being added to the clip…",
  player: (title: string): string => `The voice-over for ${title}`,
  retry: "Try again",
  retrying: "Trying again…",
  remove: "Take it off",
  removeTitle: "Take the voice-over off this clip?",
  removeDescription:
    "It comes off every size of the clip and the videos are made again without it. Adding one again later costs the same again.",
  removeConfirm: "Take it off",
});

/** Tenths of a credit as a person reads them: 20 -> "2", 15 -> "1.5". */
export function creditsText(tenths: number): string {
  return (Math.max(0, tenths) / 10).toFixed(1).replace(/\.0$/, "");
}

/**
 * What adding a voice-over costs, in full: the voice itself, plus making the
 * clip's finished (captioned) videos again with the voice in them, which is
 * charged as any video is. A size whose video is not made yet gets the voice
 * in its first one at no extra cost, so only existing videos count.
 *
 * `rerenderVideos`/`rerenderTenths` come from the server's offer; an older
 * server that does not send them gets the rate instead of a number, never
 * silence about the videos.
 */
export function voiceoverCostText(input: {
  readonly tenths: number;
  readonly rerenderVideos?: number;
  readonly rerenderTenths?: number;
  readonly renderTenthsPerMinute?: number;
}): string {
  const voice = creditsText(input.tenths);
  if (input.rerenderVideos === undefined || input.rerenderTenths === undefined) {
    const rate =
      input.renderTenthsPerMinute === undefined
        ? "the usual price of a video"
        : `${creditsText(input.renderTenthsPerMinute)} credits a minute`;
    return `Costs ${voice} credits, plus ${rate} for each of this clip's finished videos that is made again with the voice in it.`;
  }
  if (input.rerenderVideos <= 0) return `Costs ${voice} credits.`;
  const total = creditsText(input.tenths + input.rerenderTenths);
  const videos =
    input.rerenderVideos === 1
      ? "this clip's finished video"
      : `this clip's ${String(input.rerenderVideos)} finished videos`;
  return `Costs ${voice} credits for the voice, plus about ${creditsText(input.rerenderTenths)} to make ${videos} again with the voice in ${input.rerenderVideos === 1 ? "it" : "them"}: about ${total} credits in all.`;
}

/** Why a voice-over ended where it did, in one sentence. */
const FAILURE_COPY: Readonly<Record<string, string>> = Object.freeze({
  "voiceover/vendor_refused": "The voice service would not read this line.",
  "voiceover/too_long": "The line is too long to say at the start of a clip. Use a shorter one.",
  "voiceover/not_configured": "Voice-overs are not set up on our side yet. Try again later.",
  "voiceover/vendor_auth": "Voice-overs are not set up on our side yet. Try again later.",
  "jobs/stalled": "The voice-over took too long. Try again.",
});

export function voiceoverFailureCopy(code: string | null, vendorWords: string | null): string {
  const base =
    // eslint-disable-next-line security/detect-object-injection -- a miss falls back to the sentence below
    (code === null ? undefined : FAILURE_COPY[code]) ?? "Something went wrong. Try again.";
  return code === "voiceover/vendor_refused" && vendorWords !== null
    ? `${base} (${vendorWords})`
    : base;
}

/** A refused request, in one sentence. */
const REFUSAL_COPY: Readonly<Record<string, string>> = Object.freeze({
  "voiceover/not_enabled": "Voice-overs are not switched on for this workspace.",
  "voiceover/no_text": "Write the line for the voice to say.",
  "voiceover/clip_not_ready": "This clip is not ready for a voice-over yet.",
  "voiceover/language_unsupported": "A voice-over cannot be spoken in this clip's language yet.",
  "voiceover/already_has": "This clip already has a voice-over. Take it off first.",
  "voiceover/too_many": "Several voice-overs are being made. Try again in a minute.",
  "voiceover/budget_reached": "Voice-overs have reached today's limit. Try again tomorrow.",
  "voiceover/budget_unavailable": "We could not start it just now. Try again in a minute.",
  "voiceover/no_credits": "There are not enough credits for a voice-over.",
  "voiceover/not_retryable": "This voice-over cannot be tried again.",
  "voiceover/run_stopped": "This run was stopped, so nothing new can be made from it.",
  "voiceover/clip_removed": "This moment was removed. Bring it back first.",
});

export function voiceoverRefusalCopy(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return "We could not reach the server. Check your connection and try again.";
  }
  return REFUSAL_COPY[error.code] ?? "That did not work. Try again in a moment.";
}

/** Every sentence above, for the plain-words check. */
export function allVoiceoverSentences(): string[] {
  return [
    ...Object.values(VOICEOVER_COPY).flatMap((value) =>
      typeof value === "string"
        ? [value]
        : typeof value === "function"
          ? []
          : Object.values(value as Record<string, string>),
    ),
    ...Object.values(FAILURE_COPY),
    ...Object.values(REFUSAL_COPY),
  ];
}
