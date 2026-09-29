/**
 * Every sentence the dubbing surface shows (2026-10-04): the "Dub" dialog, a
 * clip's Languages section, and what each way a dub can end means to a person.
 *
 * The voice-cloning sentence is the API's own (`DUB_CONSENT_STATEMENT`): the
 * person ticks exactly the words the consent is recorded with.
 */

export const DUB_COPY = Object.freeze({
  button: "Dub",
  dialogTitle: "Dub this clip",
  dialogDescription: (from: string): string =>
    `Make this clip in other languages, in the speaker's own voice, with captions in each language. It is spoken in ${from}.`,
  languagesLegend: "Dub into",
  taken: "already dubbed",
  consent: "I have the right to use this speaker's voice, and consent to it being cloned.",
  cost: (credits: string, perMinute: string): string =>
    `Costs ${credits} credits (${perMinute} credits a minute for each language).`,
  pickSome: "Pick the languages to dub into.",
  confirm: (count: number): string =>
    count <= 1 ? "Dub into 1 language" : `Dub into ${String(count)} languages`,
  confirming: "Starting…",
  cancel: "Cancel",
  section: "Languages",
  summary: (ready: number, total: number): string => `${String(ready)} of ${String(total)} ready`,
  state: Object.freeze({
    queued: "Waiting for a free slot",
    dubbing: "Dubbing",
    making: "Making the videos",
    ready: "Ready",
    failed: "Could not be dubbed",
    cancelled: "Stopped",
  }),
  dubbingAt: (percent: number, step: string | null): string =>
    `Dubbing ${String(Math.round(percent))}%${step === null ? "" : ` · ${step}`}`,
  retry: "Try again",
  retrying: "Trying again…",
  stop: "Stop dubbing",
  stopTitle: "Stop this dub?",
  stopDescription:
    "The dub stops and its credits come back. Dubbing these languages again later costs the same again.",
  stopConfirm: "Stop dubbing",
  download: "Download",
  withoutCaptions: "Without captions",
  edit: "Edit",
  shapePreparing: "Being made…",
  shapeFailed: "Could not be made.",
  player: (language: string, title: string): string =>
    `${title}, dubbed in ${language}, 9:16 with captions`,
});

/** Tenths of a credit as a person reads them: 284 -> "28.4", 250 -> "25". */
export function creditsText(tenths: number): string {
  return (Math.max(0, tenths) / 10).toFixed(1).replace(/\.0$/, "");
}

/** The shapes' names, as the All formats panel names them. */
export const DUB_SHAPE_NAMES = Object.freeze({
  "9:16": "Vertical 9:16",
  "4:5": "Portrait 4:5",
  "1:1": "Square 1:1",
  "16:9": "Landscape 16:9",
});

/**
 * What a dub that ended means, and whether "Try again" can help. The vendor's
 * own words follow the first sentence for the two failures it wrote.
 */
const FAILURE_COPY: Readonly<Record<string, string>> = Object.freeze({
  "dub/vendor_refused": "The dubbing service could not dub this clip.",
  "dub/vendor_failed": "The dub did not work.",
  "dub/vendor_auth": "Dubbing is not set up correctly on our side yet. Try again later.",
  "dub/not_configured": "Dubbing is not set up on our side yet. Try again later.",
  "dub/vendor_timeout":
    "Dubbing is taking longer than usual. Try again to pick it up where it is, at no extra cost.",
  "dub/exports_pending":
    "The dubbed files were not ready yet. Try again to fetch them, at no extra cost.",
  "dub/no_credits": "There were not enough credits when it was this dub's turn.",
  "dub/result_mismatch": "Something went wrong with the dubbed files. Try again.",
  "jobs/stalled": "The dub stopped part way. Try again to carry on.",
});

const STOPPED_PART_WAY = "The dub stopped part way. Try again to carry on.";

/** The sentence for a failed dub: its own, with the service's words when it gave some. */
export function dubFailureCopy(code: string | null, message: string | null): string {
  // eslint-disable-next-line security/detect-object-injection -- a miss falls back to one sentence
  const sentence = (code === null ? undefined : FAILURE_COPY[code]) ?? STOPPED_PART_WAY;
  return message === null || message.trim() === "" ? sentence : `${sentence} “${message.trim()}”`;
}

/** Every fixed sentence, for the technical-word sweep. */
export function allDubSentences(): string[] {
  return [
    DUB_COPY.button,
    DUB_COPY.dialogTitle,
    DUB_COPY.dialogDescription("English"),
    DUB_COPY.languagesLegend,
    DUB_COPY.taken,
    DUB_COPY.consent,
    DUB_COPY.cost("28.4", "25"),
    DUB_COPY.pickSome,
    DUB_COPY.confirm(2),
    DUB_COPY.section,
    ...Object.values(DUB_COPY.state),
    DUB_COPY.dubbingAt(40, "Cloning the voice"),
    DUB_COPY.stopDescription,
    DUB_COPY.shapePreparing,
    DUB_COPY.shapeFailed,
    ...Object.values(FAILURE_COPY),
    STOPPED_PART_WAY,
  ];
}
