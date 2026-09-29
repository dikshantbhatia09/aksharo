/**
 * Steering a run (2026-09-29): what the start form sends about the clips
 * wanted, what the run page says back, and the nudges that move a moment's
 * start and end. Pure functions; the sentences are `STEERING_COPY`'s.
 */
import type {
  CreateRepurposeRunRequest,
  RepurposeCandidateItem,
  RepurposeRunView,
} from "@montaj/api-client";

import { STEERING_COPY } from "@/components/repurpose/copy";
import { MOMENT_MAX_MS, MOMENT_MIN_MS } from "@/components/repurpose/moment-time";

export type ClipLength = NonNullable<CreateRepurposeRunRequest["setup"]["discovery"]["clipLength"]>;
export type RunSteering = NonNullable<RepurposeRunView["steering"]>;

/**
 * The API's `CLIP_LENGTH_PRESETS` (`@montaj/repurpose-contracts`), which
 * `steering.test.ts` holds this copy equal to: the band of lengths each
 * choice asks discovery for.
 */
export const CLIP_LENGTH_PRESETS: Readonly<
  Record<ClipLength, { readonly minDurationMs: number; readonly maxDurationMs: number }>
> = Object.freeze({
  short: Object.freeze({ minDurationMs: 15_000, maxDurationMs: 35_000 }),
  medium: Object.freeze({ minDurationMs: 30_000, maxDurationMs: 60_000 }),
  long: Object.freeze({ minDurationMs: 55_000, maxDurationMs: 95_000 }),
});

export const CLIP_LENGTHS: readonly ClipLength[] = ["short", "medium", "long"];
export const DEFAULT_CLIP_LENGTH: ClipLength = "medium";

/** The most of the start, or of the end, a run may skip (the API's bound). */
export const MAX_SKIP_MINUTES = 30;
export const TOPIC_MIN_LENGTH = 2;
export const TOPIC_MAX_LENGTH = 200;

export function isClipLength(value: unknown): value is ClipLength {
  return typeof value === "string" && (CLIP_LENGTHS as readonly string[]).includes(value);
}

/** "15–35 s": a choice's band, as the form writes it beside the choice. */
export function lengthRange(length: ClipLength): string {
  // eslint-disable-next-line security/detect-object-injection -- a ClipLength, one of three literal keys
  const preset = CLIP_LENGTH_PRESETS[length];
  return `${String(preset.minDurationMs / 1000)}–${String(preset.maxDurationMs / 1000)} s`;
}

/**
 * A skip typed in minutes ("2", "1.5") in milliseconds: `undefined` for an
 * empty field or zero (nothing to skip), `null` for anything that is not a
 * number of minutes from 0 to {@link MAX_SKIP_MINUTES}.
 */
export function skipMsOf(text: string): number | null | undefined {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return undefined;
  // Digits and a decimal point only: `Number` alone would take "1e1", "-2"
  // and "0x1f" as minutes.
  if (!/^[\d.]+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes > MAX_SKIP_MINUTES) return null;
  const ms = Math.round(minutes * 60_000);
  return ms === 0 ? undefined : ms;
}

/** A topic as typed, or a problem with it; empty is no topic. */
export function topicProblem(text: string): string | undefined {
  const topic = text.trim();
  if (topic === "") return undefined;
  if (topic.length < TOPIC_MIN_LENGTH) return STEERING_COPY.topicTooShort;
  if (topic.length > TOPIC_MAX_LENGTH) return STEERING_COPY.topicTooLong;
  return undefined;
}

/** What the start form holds that steering reads. */
export interface SteeringFields {
  readonly topic: string;
  readonly clipLength: ClipLength;
  readonly skipIntro: string;
  readonly skipOutro: string;
}

/**
 * The steering part of `setup.discovery`, from the form. Only what was given:
 * no topic for an empty field, no skip for an empty or zero one. The length is
 * always sent - Medium is a choice too.
 */
export function discoverySteeringOf(
  fields: SteeringFields,
): Pick<
  CreateRepurposeRunRequest["setup"]["discovery"],
  "topic" | "clipLength" | "skipIntroMs" | "skipOutroMs"
> {
  const topic = fields.topic.trim();
  const intro = skipMsOf(fields.skipIntro);
  const outro = skipMsOf(fields.skipOutro);
  return {
    ...(topic.length >= TOPIC_MIN_LENGTH && topic.length <= TOPIC_MAX_LENGTH ? { topic } : {}),
    clipLength: fields.clipLength,
    ...(typeof intro === "number" ? { skipIntroMs: intro } : {}),
    ...(typeof outro === "number" ? { skipOutroMs: outro } : {}),
  };
}

/** "2 min", "1.5 min", "30 s": a skip as the run page says it. */
export function spanOf(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 1000))} s`;
  const minutes = Math.round((ms / 60_000) * 100) / 100;
  return `${String(minutes)} min`;
}

/**
 * The run page's one line about how it was steered - "About: money habits ·
 * Short clips · Skips the first 2 min" - or null for a run that was not.
 */
export function steeringSummary(steering: RunSteering | null | undefined): string | null {
  if (steering === null || steering === undefined) return null;
  const parts: string[] = [];
  if (steering.topic !== null && steering.topic.trim() !== "") {
    parts.push(STEERING_COPY.about(steering.topic.trim()));
  }
  if (steering.clipLength !== null) parts.push(STEERING_COPY.runLength[steering.clipLength]);
  const intro = steering.skipIntroMs > 0 ? spanOf(steering.skipIntroMs) : null;
  const outro = steering.skipOutroMs > 0 ? spanOf(steering.skipOutroMs) : null;
  if (intro !== null && outro !== null) parts.push(STEERING_COPY.skipsBoth(intro, outro));
  else if (intro !== null) parts.push(STEERING_COPY.skipsFirst(intro));
  else if (outro !== null) parts.push(STEERING_COPY.skipsLast(outro));
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A moment the person removed (`state: "rejected"`): its clip is hidden, and can be restored. */
export function isRemovedCandidate(
  candidate: Pick<RepurposeCandidateItem, "id"> & {
    readonly [key: string]: unknown;
  },
): boolean {
  return candidate["state"] === "rejected";
}

/** The steps the run page moves a start or an end by. */
export const NUDGE_STEPS_MS = [-5_000, -1_000, 1_000, 5_000] as const;

export interface MomentBounds {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * `bounds` with one side moved by `deltaMs`, kept inside the video (0:00 to
 * `durationMs`, when the page knows it), or null when the move would do
 * nothing or make a moment the API refuses (under 3 s or over 3 min). The
 * server snaps what is sent to the nearest word, so this is the time asked
 * for, not yet the time the clip will have.
 */
export function nudgeBounds(
  bounds: MomentBounds,
  side: "start" | "end",
  deltaMs: number,
  durationMs: number | null | undefined,
): MomentBounds | null {
  const end = durationMs !== null && durationMs !== undefined && durationMs > 0 ? durationMs : null;
  const next =
    side === "start"
      ? { startMs: Math.max(0, bounds.startMs + deltaMs), endMs: bounds.endMs }
      : {
          startMs: bounds.startMs,
          endMs: end === null ? bounds.endMs + deltaMs : Math.min(end, bounds.endMs + deltaMs),
        };
  if (next.startMs === bounds.startMs && next.endMs === bounds.endMs) return null;
  const length = next.endMs - next.startMs;
  if (length < MOMENT_MIN_MS || length > MOMENT_MAX_MS) return null;
  return next;
}
