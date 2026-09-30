import { z } from "zod";

/**
 * B-roll proposals (2026-10-05): the `ai.llm` job of kind `broll`, asked by
 * Autopilot's finishing pass (`apps/api/src/repurpose/clip-finishing.ts`) for
 * one clip whose run asked for B-roll (`setup.broll`).
 *
 * The API sends the clip's words that play (after its cuts, on its own clock)
 * and the bounds; the language model in `worker_ai/llm/broll.py` names the
 * moments where the speaker says something concrete and visual - a place, a
 * dish, an animal, a machine - with a short English search phrase for each.
 * Each moment is **grounded** in the words it was given: the worker keeps one
 * only when the words it quotes are found in the transcript near where it
 * says, so no moment ever carries a time the speaker did not say it at (the
 * same rule the highlights contract keeps with enumerated windows).
 *
 * The worker bounds what it returns (at most `maxMoments`, `minGapMs` apart,
 * none in `avoid`); the API bounds it again on the video as it plays
 * (`@montaj/edg` `planBroll`) and fills each moment with a picture of the
 * workspace's library, or a stock photo, or leaves it out. No model answer
 * (the chain down, the daily budget spent, a reply that grounds nothing) is
 * an empty list, never a failure: a clip is never worth failing over a
 * cutaway.
 *
 * The job's `params` are `{ kind: "broll", region, broll: BrollRequest }`; its
 * result's `output` is a {@link BrollOutputSchema}. `worker_ai/llm/broll_contracts.py`
 * mirrors both, and both sides parse the same fixtures
 * (`ai-llm-broll-request.v1.json`, `ai-llm-broll-output.v1.json`).
 */

/** The `ai.llm` kind. */
export const BROLL_LLM_KIND = "broll";

/** The template version the worker writes and the result carries. */
export const BROLL_TEMPLATE_VERSION = "broll@1";

export const BROLL_LIMITS = Object.freeze({
  /** A clip is at most three minutes: about 500 words, with room to spare. */
  maxWords: 1_500,
  maxWordChars: 64,
  maxMoments: 8,
  titleMax: 160,
  phraseMax: 60,
  spokenMax: 200,
  maxAvoid: 20,
  maxGapMs: 60_000,
});

const MsSchema = z.number().int().min(0);

/** A word id as the transcript keeps it: `"<chunk>:<n>"`. */
const WordIdSchema = z.string().regex(/^\d+:\d+$/, 'expected a word id "<chunk>:<n>"');

export const BrollWordSchema = z
  .strictObject({
    id: WordIdSchema,
    t: z.string().min(1).max(BROLL_LIMITS.maxWordChars),
    s: MsSchema,
    e: MsSchema,
  })
  .refine((word) => word.e >= word.s, { message: "a word ends after it starts" });

export const BrollSpanSchema = z
  .strictObject({ startMs: MsSchema, endMs: MsSchema })
  .refine((span) => span.endMs > span.startMs, { message: "a range ends after it starts" });

/** What the API asks: `params.broll` of an `ai.llm` job of kind `broll`. */
export const BrollRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The clip's language, BCP-47; Hinglish is `hi-Latn`. */
  language: z.string().trim().min(2).max(64),
  /** What the clip is about (its title), for context. */
  title: z.string().trim().min(1).max(BROLL_LIMITS.titleMax).optional(),
  /** The words that play, in order, on the clip's own clock. */
  words: z.array(BrollWordSchema).min(1).max(BROLL_LIMITS.maxWords),
  /** At most this many moments. */
  maxMoments: z.number().int().min(1).max(BROLL_LIMITS.maxMoments),
  /** Moments start at least this far apart, on the same clock. */
  minGapMs: z.number().int().min(0).max(BROLL_LIMITS.maxGapMs),
  /** No moment's words may fall here: the hook's first seconds, an end card. */
  avoid: z.array(BrollSpanSchema).max(BROLL_LIMITS.maxAvoid),
});

/** One moment: the words that name the thing, and what to look for. */
export const BrollMomentSchema = z.strictObject({
  startWordId: WordIdSchema,
  endWordId: WordIdSchema,
  /** The first word's start and the last word's end. */
  startMs: MsSchema,
  endMs: MsSchema,
  /** One to six English words naming what a picture would show: a stock photo search. */
  phrase: z.string().trim().min(2).max(BROLL_LIMITS.phraseMax),
  /** The words as the speaker said them. */
  spoken: z.string().max(BROLL_LIMITS.spokenMax),
  /** How concrete and visual the thing named is, 0 to 10. */
  score: z.number().int().min(0).max(10),
});

/** What the worker answers: the `output` of the job's result. */
export const BrollOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** In time order; empty is a legitimate answer. */
  moments: z.array(BrollMomentSchema).max(BROLL_LIMITS.maxMoments),
  /** `model` when a language model answered; `none` when none could be asked. */
  source: z.enum(["model", "none"]),
});

export type BrollWord = z.infer<typeof BrollWordSchema>;
export type BrollSpan = z.infer<typeof BrollSpanSchema>;
export type BrollRequest = z.infer<typeof BrollRequestSchema>;
export type BrollMoment = z.infer<typeof BrollMomentSchema>;
export type BrollOutput = z.infer<typeof BrollOutputSchema>;

/**
 * `ai.llm:broll:{projectId}:{revision}`: one ask per clip shape and document
 * revision. The revision is in the key on purpose: a shape edited since is a
 * different set of words to ask about.
 */
export function brollJobKey(projectId: string, revision: number): string {
  return `ai.llm:${BROLL_LLM_KIND}:${projectId}:${String(revision)}`;
}
