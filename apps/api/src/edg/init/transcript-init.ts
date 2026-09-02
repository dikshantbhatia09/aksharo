import type { ScriptId, Speaker, TranscriptChunk } from "@montaj/edg/schemas";
import { DEFAULT_SEGMENTER_PARAMS } from "@montaj/edg/segmenter";
import type { SegmenterParams } from "@montaj/edg/segmenter";

import { budgetsForMeta, type CaptionBudgets } from "./caption-budgets.js";

import type { EdgInitInput } from "../edg.service.js";

/**
 * `src/edg/init/` — A11's half of the editing document's birth.
 *
 * A12 owns `EdgService.initialise`: the transaction, the segment rows, revision 1
 * and the snapshot under it. What it does **not** own is the decision of what to
 * hand that call — which scripts the transcript carries, who the speakers are,
 * what caption limits this workspace wants, whether fillers belong on screen. That
 * is a transcript question, and it is answered here, as a pure function, so the
 * completion handler stays a list of writes and the choices are unit-testable
 * without a database or a Nest module.
 *
 * The segmenter limits themselves are **not** re-specified here. `09 §3`'s table
 * lives in `@montaj/edg/segmenter` (per script: Latin 32 chars at 20 CPS,
 * Devanagari 24 at 15, Tamil 22 at 15) and the segmenter picks the row from the
 * script the words are actually written in — which is the only correct behaviour
 * for a Hinglish transcript that mixes both. All this adds is the workspace's
 * overrides, and it refuses to widen a limit past what a caption can hold.
 */

/** Caption preferences a workspace may set. Everything omitted falls to `09 §3`. */
export interface CaptionPreferences {
  /** Lines a caption may occupy. 1–3; more is a wall of text over the speaker's face. */
  readonly maxLines?: number;
  /** Shortest caption, ms. */
  readonly minMs?: number;
  /** Longest caption, ms. */
  readonly maxMs?: number;
  /** Characters a line may hold. Overrides the script's own limit — use sparingly. */
  readonly maxChars?: number;
  /** Leave tagged fillers out of the captions. Defaults to true. */
  readonly dropFillers?: boolean;
  /** Style every initial caption carries. */
  readonly styleRef?: string;
}

/** Bounds a preference may not cross, whatever a client sends. */
export const CAPTION_BOUNDS = {
  maxLines: { min: 1, max: 3 },
  minMs: { min: 200, max: 3_000 },
  maxMs: { min: 1_000, max: 12_000 },
  maxChars: { min: 12, max: 60 },
} as const;

/** The default style a project's captions start on (A19 owns the catalogue). */
export const DEFAULT_STYLE_REF = "clean-bold";

export interface TranscriptEdgInitOptions {
  readonly transcriptId: string;
  readonly language: string;
  readonly scripts: readonly ScriptId[];
  readonly chunks: readonly TranscriptChunk[];
  readonly speakers?: readonly Speaker[];
  readonly preferences?: CaptionPreferences;
  /**
   * The caption budgets `resolveBudgets` computed for this project's canvas and
   * style (decision D78). They override the segmenter's own per-script table and
   * are recorded on the document so a later reflow knows what they were.
   */
  readonly budgets?: CaptionBudgets;
  readonly author?: string | null;
}

/**
 * Build the `EdgInitInput` for a freshly persisted transcript.
 *
 * `source` is always `"worker"`: the document is created off the back of a job
 * completion, and the revision log should say so rather than name whichever user
 * happened to press Transcribe.
 */
export function edgInitInputFor(options: TranscriptEdgInitOptions): EdgInitInput {
  const preferences = options.preferences ?? {};
  const budgets = options.budgets;
  // The budget already IS `min(readability, fit, preference)` (D78), so it wins
  // over the raw preference rather than being merged with it.
  const segmenter: Partial<SegmenterParams> = {
    ...segmenterParamsFor(preferences),
    ...(budgets === undefined ? {} : { maxChars: budgets.maxChars, maxLines: budgets.maxLines }),
  };
  const speakers = options.speakers ?? speakersFrom(options.chunks);

  return {
    transcriptId: options.transcriptId,
    language: options.language,
    scripts: options.scripts.length === 0 ? ["roman"] : [...options.scripts],
    chunks: options.chunks,
    ...(speakers.length === 0 ? {} : { speakers }),
    ...(Object.keys(segmenter).length === 0 ? {} : { segmenter }),
    ...(budgets === undefined ? {} : { engineVersions: budgetsForMeta(budgets) }),
    dropFillers: preferences.dropFillers ?? true,
    styleRef: budgets?.styleRef ?? preferences.styleRef ?? DEFAULT_STYLE_REF,
    author: options.author ?? null,
    source: "worker",
  };
}

/**
 * The workspace's overrides, clamped, with anything unset left to the segmenter's
 * own `09 §3` defaults.
 *
 * `minMs` may not exceed `maxMs`: a pair that crosses would make every caption
 * "too short" and the merge pass would fold the whole transcript into one.
 */
export function segmenterParamsFor(preferences: CaptionPreferences): Partial<SegmenterParams> {
  const params: Partial<SegmenterParams> = {};

  if (preferences.maxLines !== undefined) {
    params.maxLines = clamp(preferences.maxLines, CAPTION_BOUNDS.maxLines);
  }
  if (preferences.maxChars !== undefined) {
    params.maxChars = clamp(preferences.maxChars, CAPTION_BOUNDS.maxChars);
  }

  const minMs =
    preferences.minMs === undefined ? undefined : clamp(preferences.minMs, CAPTION_BOUNDS.minMs);
  const maxMs =
    preferences.maxMs === undefined ? undefined : clamp(preferences.maxMs, CAPTION_BOUNDS.maxMs);

  if (minMs !== undefined) {
    params.minMs = Math.min(minMs, maxMs ?? DEFAULT_SEGMENTER_PARAMS.maxMs);
  }
  if (maxMs !== undefined) {
    params.maxMs = Math.max(maxMs, params.minMs ?? DEFAULT_SEGMENTER_PARAMS.minMs);
  }
  return params;
}

/** The speakers a transcript names, in first-appearance order. */
export function speakersFrom(chunks: readonly TranscriptChunk[]): Speaker[] {
  const seen = new Set<string>();
  const speakers: Speaker[] = [];
  for (const chunk of chunks) {
    for (const word of chunk.words) {
      const id = word.sp;
      if (id === undefined || id === "" || seen.has(id)) continue;
      seen.add(id);
      speakers.push({ id });
    }
  }
  return speakers;
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}
