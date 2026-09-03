/**
 * D04e: mixes accepted `sfx` (and, once D05 lands, `music`) cue audio into the
 * cloud render's output track.
 *
 * Each cue is its own ffmpeg input (the pack asset's decoded WAV, downloaded
 * by `render/pipeline.ts` to the job's scratch dir) and becomes its own filter
 * chain: `atrim`/`asetpts` to the cue's own slice of the asset, a static
 * `volume` for the pass's own `gainDb`, linear `afade`s at the cue's own edges,
 * `adelay` to place it at its *output*-clock start (`@montaj/timemap`'s
 * `mapRange`, the same remap `B20`'s crop keyframes and `D06b`'s titles use for
 * cuts/ripples), and — only when the item carries a `duck` curve — a second,
 * `eval=frame` `volume` expression (`sfx-duck-expr.ts`'s closed-form trapezoid)
 * that quiets the cue itself under speech, matching `apps/web/lib/export/
 * engine.ts`'s `applySfxDucking` exactly (D04a; proven by `parity/sfx-parity.ts`).
 *
 * `duck` ducks the *cue*, not the dialogue bus: `sfx-duck-expr.ts`'s own doc
 * comment already says so ("applied to the SFX layer itself"), and `engine.ts`'s
 * `applySfxDucking` likewise multiplies the cue buffer, never the dialogue
 * track. The WP brief's prose describes this the other way round ("dialogue
 * bus `volume` driven by the duck expression"); this module follows the
 * already-shipped, parity-tested D04a contract instead and the discrepancy is
 * called out in the D04e final report rather than silently reinterpreting
 * either.
 *
 * A cue that straddles a cut is not a single `adelay`d clip: `mapRange` answers
 * with one `OutputRange` per retained piece, so a cue is built as one filter
 * chain *per piece*, each independently trimmed to that piece's slice of the
 * asset and delayed to that piece's own output start — the same "cut removes a
 * piece, everything after ripples left" property every other track (crop
 * keyframes, titles) already gets from this remap.
 *
 * Every cue chain ends in its own uniquely-labelled stream; the caller
 * (`graph.ts`) `amix`es all of them together with whatever dialogue bus label
 * it already has.
 */

import type { DuckTrack } from "@montaj/render-manifest";
import type { TimeQuery } from "@montaj/timemap";

import { buildSfxDuckAudioFilter, dbToLinear, type SpeechRange } from "./sfx-duck-expr.js";

export type { SpeechRange } from "./sfx-duck-expr.js";

/**
 * D04e-3: samples per frame forced right before a duck's `volume=eval=frame`
 * filter. That filter recomputes its expression once per *frame*, not per
 * sample — left at whatever frame size the graph otherwise settles on
 * (often tens of milliseconds), the ramp ffmpeg actually produces is a
 * coarse staircase rather than the smooth trapezoid the expression
 * describes and the browser mixer computes per sample. 64 samples (~1.3ms
 * at 48kHz) is well under the shortest ramp (`SFX_DUCK_RAMP_MS`, 150ms) and
 * closed the multi-dB gap the envelope-parity gate
 * (`parity/run-audio-mix-parity.ts`) found between real ffmpeg output and
 * the closed form, right where the ramp is steepest.
 */
export const DUCK_FRAME_SAMPLES = 64;

/** Consecutive words closer than this merge into one speech region — same
 * fallback shape `apps/api/src/passes/passes.service.ts#speechRangesFromWords`
 * uses; duplicated rather than imported (apps do not import one another). */
export const SPEECH_MERGE_GAP_MS = 160;

export interface TranscriptWordLike {
  readonly s: number;
  readonly e: number;
  readonly filler?: boolean;
  readonly deleted?: boolean;
}

/** Where speech actually is, approximated from live (non-deleted) word timing. */
export function speechRangesFromWords(
  words: readonly TranscriptWordLike[],
  durationMs: number,
): SpeechRange[] {
  const live = words.filter((word) => word.deleted !== true).sort((a, b) => a.s - b.s);
  if (live.length === 0) return [];
  const regions: SpeechRange[] = [];
  let start = live[0]?.s ?? 0;
  let end = live[0]?.e ?? 0;
  for (const word of live.slice(1)) {
    if (word.s - end <= SPEECH_MERGE_GAP_MS) {
      end = Math.max(end, word.e);
    } else {
      regions.push({ startMs: start, endMs: Math.min(end, durationMs) });
      start = word.s;
      end = word.e;
    }
  }
  regions.push({ startMs: start, endMs: Math.min(end, durationMs) });
  return regions;
}

/** One accepted `sfx` cue, ready to mix: the manifest's own fields plus the
 * local path of its downloaded asset and the ffmpeg input index it was given. */
export interface SfxMixCue {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly duck: DuckTrack | null;
  readonly localPath: string;
}

/** One accepted `music` cue (D05's `MusicPayload`, CONTRACTS §2), ready to mix. */
export interface MusicMixCue {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly gainDb: number;
  readonly loopPolicy: "none" | "loop" | "trim";
  readonly bedDuck: DuckTrack | null;
  readonly localPath: string;
  /** The asset's own natural duration, needed to decide whether/how much to loop. */
  readonly assetDurationMs: number;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(6);
}

/** Retained pieces of `[startMs, endMs)` on the output clock, or the identity
 * single piece when there is no timemap (an unedited render). */
function piecesFor(
  startMs: number,
  endMs: number,
  timemap: TimeQuery | null,
): { sourceStart: number; sourceEnd: number; outputStart: number; outputEnd: number }[] {
  if (timemap === null) {
    return [{ sourceStart: startMs, sourceEnd: endMs, outputStart: startMs, outputEnd: endMs }];
  }
  return timemap.mapRange(startMs, endMs);
}

/** One cue's full filter chain, split per retained piece; each piece becomes
 * its own labelled stream, later all `amix`ed together by the caller. */
export function buildCueFilters(
  cue: SfxMixCue,
  inputIndex: number,
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
): { readonly filters: string[]; readonly labels: string[] } {
  const pieces = piecesFor(cue.startMs, cue.endMs, timemap);
  const filters: string[] = [];
  const labels: string[] = [];
  const cueDurationMs = cue.endMs - cue.startMs;

  pieces.forEach((piece, pieceIndex) => {
    const assetStartMs = piece.sourceStart - cue.startMs;
    const assetEndMs = piece.sourceEnd - cue.startMs;
    if (assetEndMs <= assetStartMs) return;

    const label = `sfx${String(inputIndex)}_${String(pieceIndex)}`;
    const steps: string[] = [
      `atrim=start=${seconds(assetStartMs)}:end=${seconds(assetEndMs)}`,
      "asetpts=PTS-STARTPTS",
    ];

    const gainLinear = dbToLinear(cue.gainDb);
    if (gainLinear !== 1) steps.push(`volume=${gainLinear.toFixed(6)}`);

    // Fades belong to the *cue's own* edges, so only the piece touching that
    // edge gets one — a piece created by a mid-cue cut is an internal splice,
    // not the cue's fade-in/out.
    const isFirstPiece = Math.abs(assetStartMs) < 0.5;
    const isLastPiece = Math.abs(assetEndMs - cueDurationMs) < 0.5;
    if (isFirstPiece && cue.fadeInMs > 0) {
      steps.push(`afade=type=in:start_time=0:duration=${seconds(cue.fadeInMs)}`);
    }
    if (isLastPiece && cue.fadeOutMs > 0) {
      const pieceDurationMs = assetEndMs - assetStartMs;
      const fadeOutStartMs = Math.max(0, pieceDurationMs - cue.fadeOutMs);
      steps.push(
        `afade=type=out:start_time=${seconds(fadeOutStartMs)}:duration=${seconds(cue.fadeOutMs)}`,
      );
    }

    const delayMs = Math.max(0, Math.round(piece.outputStart));
    steps.push(`adelay=${String(delayMs)}|${String(delayMs)}`);

    // The duck curve runs *last*, on the delayed stream: `adelay` shifts this
    // stream's own pts so `t` (what `volume=eval=frame` reads) now agrees with
    // the master output clock the speech ranges are expressed in — running it
    // before `adelay` would compare a 0-based asset clock against output-clock
    // speech ranges, which is wrong for every cue that isn't at t=0.
    if (cue.duck !== null && speechRanges.length > 0) {
      steps.push(`asetnsamples=n=${String(DUCK_FRAME_SAMPLES)}:p=0`);
      steps.push(
        buildSfxDuckAudioFilter(speechRanges, {
          duckDb: cue.duck.depthDb,
          rampMs: cue.duck.attackMs,
        }),
      );
    }

    filters.push(`[${String(inputIndex)}:a]${steps.join(",")}[${label}]`);
    labels.push(label);
  });

  return { filters, labels };
}

/** A music bed's filter chain: optionally looped/trimmed to the item's own
 * window, gained, and — when `bedDuck` is set — ducked under speech the same
 * way an `sfx` cue is. Simpler than `buildCueFilters`: a bed is not expected to
 * straddle a cut the way a short cue might (D05's `loopPolicy` already accounts
 * for the bed running under edited material), so this builds one piece per
 * `mapRange` result but does not special-case fades (music has none of its own
 * in `MusicPayload`).
 */
export function buildMusicFilters(
  music: MusicMixCue,
  inputIndex: number,
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
): { readonly filters: string[]; readonly labels: string[] } {
  const pieces = piecesFor(music.startMs, music.endMs, timemap);
  const filters: string[] = [];
  const labels: string[] = [];
  const windowDurationMs = music.endMs - music.startMs;

  pieces.forEach((piece, pieceIndex) => {
    const assetStartMs = piece.sourceStart - music.startMs;
    const assetEndMs = piece.sourceEnd - music.startMs;
    if (assetEndMs <= assetStartMs) return;

    const label = `music${String(inputIndex)}_${String(pieceIndex)}`;
    const steps: string[] = [];

    if (music.loopPolicy === "loop" && music.assetDurationMs < windowDurationMs) {
      // `aloop=loop=-1` repeats the whole decoded input indefinitely;
      // `atrim` afterwards cuts it down to exactly the window this piece
      // needs, counted from the *loop's own* start (the asset itself), not
      // from `assetStartMs` — a looped bed has no single natural offset, so
      // it always starts its loop at the top of the asset.
      steps.push("aloop=loop=-1:size=2147483647");
      steps.push(`atrim=start=0:end=${seconds(assetEndMs - assetStartMs)}`, "asetpts=PTS-STARTPTS");
    } else {
      // `none`/`trim`, or a bed already longer than the window: a plain trim
      // to this piece's slice of the asset.
      steps.push(
        `atrim=start=${seconds(Math.max(0, assetStartMs))}:end=${seconds(Math.min(assetEndMs, music.assetDurationMs))}`,
        "asetpts=PTS-STARTPTS",
      );
    }

    const gainLinear = dbToLinear(music.gainDb);
    if (gainLinear !== 1) steps.push(`volume=${gainLinear.toFixed(6)}`);

    const delayMs = Math.max(0, Math.round(piece.outputStart));
    steps.push(`adelay=${String(delayMs)}|${String(delayMs)}`);

    if (music.bedDuck !== null && speechRanges.length > 0) {
      steps.push(`asetnsamples=n=${String(DUCK_FRAME_SAMPLES)}:p=0`);
      steps.push(
        buildSfxDuckAudioFilter(speechRanges, {
          duckDb: music.bedDuck.depthDb,
          rampMs: music.bedDuck.attackMs,
        }),
      );
    }

    filters.push(`[${String(inputIndex)}:a]${steps.join(",")}[${label}]`);
    labels.push(label);

    void pieceIndex;
  });

  return { filters, labels };
}

export interface AudioMixPlan {
  /** Extra `-i` args, in the order their input indices were assigned. */
  readonly extraInputArgs: readonly string[];
  readonly filters: readonly string[];
  /** The single label (unbracketed) the mixed bus ends up on. */
  readonly outLabel: string;
}

/**
 * Builds the whole cue-mixing addition to the filter graph: one `-i` per cue/
 * music asset, their per-cue filter chains, and a final `amix` combining every
 * cue/music label with the existing dialogue bus label (or an `anullsrc` bed
 * when there is no dialogue track at all but cues still need to play).
 *
 * `dialogueLabel` is either a filter label already produced upstream (no
 * colon — wrapped in brackets here) or a raw ffmpeg input reference such as
 * `"2:a"` (has a colon — used as-is): `graph.ts`'s existing `audioLabel`
 * carries both forms depending on whether the render replaced the audio track.
 */
export function buildAudioMixPlan(input: {
  readonly dialogueLabel: string | null;
  readonly sfxCues: readonly SfxMixCue[];
  readonly musicCues: readonly MusicMixCue[];
  readonly timemap: TimeQuery | null;
  readonly speechRanges: readonly SpeechRange[];
  readonly outputDurationMs: number;
  readonly nextInputIndex: number;
  readonly sampleRate: number;
}): AudioMixPlan | null {
  if (input.sfxCues.length === 0 && input.musicCues.length === 0) return null;

  const extraInputArgs: string[] = [];
  const filters: string[] = [];
  const mixLabels: string[] = [];
  let inputIndex = input.nextInputIndex;

  for (const cue of input.sfxCues) {
    extraInputArgs.push("-i", cue.localPath);
    const built = buildCueFilters(cue, inputIndex, input.timemap, input.speechRanges);
    filters.push(...built.filters);
    mixLabels.push(...built.labels);
    inputIndex += 1;
  }

  for (const music of input.musicCues) {
    extraInputArgs.push("-i", music.localPath);
    const built = buildMusicFilters(music, inputIndex, input.timemap, input.speechRanges);
    filters.push(...built.filters);
    mixLabels.push(...built.labels);
    inputIndex += 1;
  }

  const dialogueRef = input.dialogueLabel === null ? null : `[${input.dialogueLabel}]`;

  const busInputs: string[] = [];
  if (dialogueRef !== null) busInputs.push(dialogueRef);
  else {
    // No dialogue track at all (silent source, or strategy asked for none of
    // its own audio to carry through) but cues still need a bed to mix onto —
    // `anullsrc` for the render's own length and sample rate.
    filters.push(
      `anullsrc=r=${String(input.sampleRate)}:cl=stereo,` +
        `atrim=duration=${seconds(input.outputDurationMs)},asetpts=PTS-STARTPTS[dialoguebed]`,
    );
    busInputs.push("[dialoguebed]");
  }
  for (const label of mixLabels) busInputs.push(`[${label}]`);

  const outLabel = "mixout";
  if (busInputs.length === 1) {
    // Only the dialogue bed and nothing else ended up mixable (every cue
    // piece fell entirely inside a cut) — pass it through unchanged rather
    // than an `amix=inputs=1`, which ffmpeg accepts but which is a pointless
    // extra filter node.
    return { extraInputArgs, filters, outLabel: busInputs[0]?.replace(/[[\]]/g, "") ?? outLabel };
  }
  filters.push(
    `${busInputs.join("")}amix=inputs=${String(busInputs.length)}:normalize=0[${outLabel}]`,
  );

  return { extraInputArgs, filters, outLabel };
}
