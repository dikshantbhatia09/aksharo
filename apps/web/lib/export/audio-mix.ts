/**
 * D04e-2: mixes accepted `sfx` (and, once `music` lands, music-bed) cue audio
 * into the browser export's audio track.
 *
 * The export engine (`engine.ts`) does not build a Web Audio graph at all —
 * its audio path streams `AudioBuffer` chunks straight from Mediabunny's
 * `AudioSampleSink` into an `AudioBufferSource`, one retained range at a time
 * (see `engine.ts`'s own doc comment). There is no `OfflineAudioContext` to
 * schedule an `AudioBufferSourceNode` + `GainNode` graph against; mixing a cue
 * in here instead means adding its own (gained/faded/ducked) samples directly
 * into whichever chunk overlaps it, in place — the same style `engine.ts`'s
 * existing `applySpliceFades`/`applySfxDucking` already use for their own
 * per-sample work. This is a deliberate deviation from the WP brief's
 * `AudioBufferSourceNode`/`GainNode`/`OfflineAudioContext` prose, which
 * assumed an architecture this codebase does not have; called out in the
 * D04e final report.
 *
 * A cue's own window is expressed on the *source* clock (`SfxTrack.startMs`/
 * `endMs`, same convention as every other accepted-item track); mixing it in
 * needs the *output*-clock pieces `@montaj/timemap`'s `mapRange` produces —
 * the identical remap `apps/render`'s `audio-mix.ts` uses for cuts/ripples,
 * so a cue lands at the same instant whichever engine renders it (proven by
 * `packages/render-manifest` parity, D04e-3).
 */

import type { DuckTrack } from "@montaj/render-manifest";
import type { TimeQuery } from "@montaj/timemap";

import { dbToLinear, duckGainAt, SFX_DUCK_DB, SFX_DUCK_RAMP_MS } from "./engine";

/** Consecutive words closer than this merge into one speech region — same
 * fallback shape `apps/api/src/passes/passes.service.ts#speechRangesFromWords`
 * and `apps/render/src/ffmpeg/audio-mix.ts#speechRangesFromWords` use;
 * duplicated rather than imported (apps do not import one another). */
export const SPEECH_MERGE_GAP_MS = 160;

export interface TranscriptWordLike {
  readonly s: number;
  readonly e: number;
  readonly deleted?: boolean;
}

export interface SpeechRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Speech ranges on the **source** clock (words are timed there) moved onto the
 * **output** clock every duck is evaluated on (2026-10-04) - the twin of
 * `apps/render/src/ffmpeg/audio-mix.ts`'s `outputSpeechRanges`. A range a cut
 * runs through becomes the pieces that remain; pieces that touch on the
 * output clock are one range again. Before this, both engines ducked
 * source-clock ranges on the output clock, late by the cuts before them.
 */
export function outputSpeechRanges(
  ranges: readonly SpeechRange[],
  timemap: TimeQuery | null,
): SpeechRange[] {
  if (timemap === null) return ranges.map((range) => ({ ...range }));
  const pieces: SpeechRange[] = [];
  for (const range of ranges) {
    for (const piece of timemap.mapRange(range.startMs, range.endMs)) {
      if (piece.outputEnd > piece.outputStart) {
        pieces.push({ startMs: piece.outputStart, endMs: piece.outputEnd });
      }
    }
  }
  pieces.sort((a, b) => a.startMs - b.startMs);
  const merged: SpeechRange[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (last !== undefined && piece.startMs <= last.endMs + 0.5) {
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, piece.endMs),
      };
    } else {
      merged.push(piece);
    }
  }
  return merged;
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

/** One accepted `sfx` cue: the manifest's own fields plus its asset already
 * decoded to an `AudioBuffer` (`decodeAudioData` on the bytes the D04d signed
 * URL/`fetchCueAsset` hook returned — done once per export, outside this
 * module, so every function here stays a pure, synchronously-testable mixer
 * over already-decoded buffers). */
export interface SfxMixCue {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly duck: DuckTrack | null;
  readonly buffer: AudioBuffer;
  /** The voice-over hook (2026-10-01): play whole through later cuts ({@link playedWindowOf}). */
  readonly playThrough?: boolean;
  /** The voice-over hook (2026-10-01): the clip's own sound under it ({@link applyDialogueDucks}). */
  readonly dialogueDuck?: DuckTrack;
}

/** One accepted `music` cue (D05's `MusicPayload`, CONTRACTS §2). */
export interface MusicMixCue {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly gainDb: number;
  readonly loopPolicy: "none" | "loop" | "trim";
  readonly bedDuck: DuckTrack | null;
  readonly buffer: AudioBuffer;
}

/** Retained pieces of `[startMs, endMs)` on the output clock, or the identity
 * single piece when there is no timemap (an unedited render) — mirrors
 * `apps/render/src/ffmpeg/audio-mix.ts`'s `piecesFor` exactly. */
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

/** One buffer's sample at `channel`, or its mono/first-channel value when the
 * asset has fewer channels than the destination chunk needs. */
function sampleAt(buffer: AudioBuffer, channel: number, index: number): number {
  if (index < 0 || index >= buffer.length) return 0;
  const usableChannel = Math.min(channel, buffer.numberOfChannels - 1);
  // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, bounds-checked index, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return buffer.getChannelData(usableChannel)[index] ?? 0;
}

/**
 * Adds one cue's samples into `chunk`, in place, for whatever portion of the
 * chunk overlaps the cue's output-clock window(s).
 *
 * `chunkOutputStartMs` is the chunk's own position on the *finished*
 * (output) timeline — the running total the caller accumulates across every
 * chunk of every retained range, not `applySpliceFades`'s per-range
 * `elapsedMs`, which resets at each splice.
 */
export function mixSfxCueIntoChunk(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  cue: SfxMixCue,
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
  outputDurationMs: number = Number.POSITIVE_INFINITY,
): void {
  if (cue.playThrough === true) {
    mixPlayThroughCueIntoChunk(
      chunk,
      chunkOutputStartMs,
      cue,
      timemap,
      speechRanges,
      outputDurationMs,
    );
    return;
  }
  const pieces = piecesFor(cue.startMs, cue.endMs, timemap);
  const cueDurationMs = cue.endMs - cue.startMs;
  const gainLinear = dbToLinear(cue.gainDb);
  const chunkMsPerSample = 1000 / chunk.sampleRate;
  const chunkDurationMs = chunk.length * chunkMsPerSample;
  const chunkOutputEndMs = chunkOutputStartMs + chunkDurationMs;

  for (const piece of pieces) {
    const overlapStartMs = Math.max(chunkOutputStartMs, piece.outputStart);
    const overlapEndMs = Math.min(chunkOutputEndMs, piece.outputEnd);
    if (overlapEndMs <= overlapStartMs) continue;

    const assetPieceStartMs = piece.sourceStart - cue.startMs;
    const assetPieceEndMs = piece.sourceEnd - cue.startMs;
    const isFirstPiece = Math.abs(assetPieceStartMs) < 0.5;
    const isLastPiece = Math.abs(assetPieceEndMs - cueDurationMs) < 0.5;

    for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
      const destination = chunk.getChannelData(channel);
      for (let i = 0; i < chunk.length; i += 1) {
        const sampleOutputMs = chunkOutputStartMs + i * chunkMsPerSample;
        if (sampleOutputMs < overlapStartMs || sampleOutputMs >= overlapEndMs) continue;

        const assetMs = sampleOutputMs - piece.outputStart + assetPieceStartMs;
        const assetIndex = Math.round((assetMs / 1000) * cue.buffer.sampleRate);
        let gain = gainLinear;

        if (isFirstPiece && cue.fadeInMs > 0 && assetMs < cue.fadeInMs) {
          gain *= Math.max(0, assetMs / cue.fadeInMs);
        }
        if (isLastPiece && cue.fadeOutMs > 0 && assetMs > cueDurationMs - cue.fadeOutMs) {
          gain *= Math.max(0, (cueDurationMs - assetMs) / cue.fadeOutMs);
        }
        if (cue.duck !== null) {
          gain *= duckGainAt(sampleOutputMs, speechRanges, cue.duck.depthDb, cue.duck.attackMs);
        }

        // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, loop-bounded index, not attacker-controlled
        destination[i] = (destination[i] ?? 0) + sampleAt(cue.buffer, channel, assetIndex) * gain;
      }
    }
  }
}

/** `mixSfxCueIntoChunk` over every cue; the common entry point `engine.ts` calls. */
export function mixSfxCuesIntoChunk(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  cues: readonly SfxMixCue[],
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
  outputDurationMs: number = Number.POSITIVE_INFINITY,
): void {
  for (const cue of cues) {
    mixSfxCueIntoChunk(chunk, chunkOutputStartMs, cue, timemap, speechRanges, outputDurationMs);
  }
}

/**
 * Where a play-through cue sounds on the finished video (2026-10-01, the
 * voice-over hook) - the twin of `apps/render/src/ffmpeg/audio-mix.ts`'s
 * `playedWindowOf`: from the output instant its first retained piece starts,
 * for the rest of its asset (straight through any cut after that), never past
 * the end of the video. `null` when nothing of it survives or fits.
 */
export function playedWindowOf(
  cue: Pick<SfxMixCue, "startMs" | "endMs">,
  timemap: TimeQuery | null,
  outputDurationMs: number = Number.POSITIVE_INFINITY,
): {
  readonly outputStart: number;
  readonly outputEnd: number;
  readonly assetOffsetMs: number;
} | null {
  const first = piecesFor(cue.startMs, cue.endMs, timemap).find(
    (piece) => piece.outputEnd > piece.outputStart,
  );
  if (first === undefined) return null;
  const assetOffsetMs = Math.max(0, first.sourceStart - cue.startMs);
  const remainingMs = cue.endMs - cue.startMs - assetOffsetMs;
  const outputEnd = Math.min(first.outputStart + remainingMs, outputDurationMs);
  if (!(outputEnd > first.outputStart)) return null;
  return { outputStart: first.outputStart, outputEnd, assetOffsetMs };
}

/** A play-through cue ({@link playedWindowOf}): one span, faded at what plays of it. */
function mixPlayThroughCueIntoChunk(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  cue: SfxMixCue,
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
  outputDurationMs: number,
): void {
  const window = playedWindowOf(cue, timemap, outputDurationMs);
  if (window === null) return;
  const lengthMs = window.outputEnd - window.outputStart;
  const gainLinear = dbToLinear(cue.gainDb);
  const chunkMsPerSample = 1000 / chunk.sampleRate;
  const chunkOutputEndMs = chunkOutputStartMs + chunk.length * chunkMsPerSample;
  const overlapStartMs = Math.max(chunkOutputStartMs, window.outputStart);
  const overlapEndMs = Math.min(chunkOutputEndMs, window.outputEnd);
  if (overlapEndMs <= overlapStartMs) return;
  const fadesIn = window.assetOffsetMs < 0.5 && cue.fadeInMs > 0;

  for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
    const destination = chunk.getChannelData(channel);
    for (let i = 0; i < chunk.length; i += 1) {
      const sampleOutputMs = chunkOutputStartMs + i * chunkMsPerSample;
      if (sampleOutputMs < overlapStartMs || sampleOutputMs >= overlapEndMs) continue;
      const playedMs = sampleOutputMs - window.outputStart;
      let gain = gainLinear;
      if (fadesIn && playedMs < cue.fadeInMs) gain *= Math.max(0, playedMs / cue.fadeInMs);
      if (cue.fadeOutMs > 0 && playedMs > lengthMs - cue.fadeOutMs) {
        gain *= Math.max(0, (lengthMs - playedMs) / cue.fadeOutMs);
      }
      if (cue.duck !== null) {
        gain *= duckGainAt(sampleOutputMs, speechRanges, cue.duck.depthDb, cue.duck.attackMs);
      }
      const assetMs = window.assetOffsetMs + playedMs;
      const assetIndex = Math.round((assetMs / 1000) * cue.buffer.sampleRate);
      // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, loop-bounded index, not attacker-controlled
      destination[i] = (destination[i] ?? 0) + sampleAt(cue.buffer, channel, assetIndex) * gain;
    }
  }
}

/**
 * The output-clock windows a cue's `dialogueDuck` covers: the one window a
 * play-through cue plays in, or every retained piece of an ordinary cue (the
 * twin of the cloud render's `dialogueDuckWindows`).
 */
export function dialogueDuckWindows(
  cue: Pick<SfxMixCue, "startMs" | "endMs" | "playThrough">,
  timemap: TimeQuery | null,
  outputDurationMs: number = Number.POSITIVE_INFINITY,
): SpeechRange[] {
  if (cue.playThrough === true) {
    const window = playedWindowOf(cue, timemap, outputDurationMs);
    return window === null ? [] : [{ startMs: window.outputStart, endMs: window.outputEnd }];
  }
  return piecesFor(cue.startMs, cue.endMs, timemap)
    .filter((piece) => piece.outputEnd > piece.outputStart)
    .map((piece) => ({ startMs: piece.outputStart, endMs: piece.outputEnd }));
}

/**
 * Pulls the clip's own sound in `chunk` down under every cue that asks for it
 * (2026-10-01, the voice-over hook's `dialogueDuck`), in place, BEFORE the cues
 * are added - so the duck lands on the dialogue alone, as the cloud render's
 * `volume` on its dialogue bus does. The same trapezoid as every other duck
 * (`duckGainAt`). A chunk no such cue touches is left exactly as it was.
 */
export function applyDialogueDucks(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  cues: readonly SfxMixCue[],
  timemap: TimeQuery | null,
  outputDurationMs: number = Number.POSITIVE_INFINITY,
): void {
  const ducks: { readonly windows: SpeechRange[]; readonly duck: DuckTrack }[] = [];
  for (const cue of cues) {
    if (cue.dialogueDuck === undefined) continue;
    const windows = dialogueDuckWindows(cue, timemap, outputDurationMs);
    if (windows.length > 0) ducks.push({ windows, duck: cue.dialogueDuck });
  }
  if (ducks.length === 0) return;
  const chunkMsPerSample = 1000 / chunk.sampleRate;
  const chunkOutputEndMs = chunkOutputStartMs + chunk.length * chunkMsPerSample;
  const touches = ducks.some(({ windows, duck }) =>
    windows.some(
      (window) =>
        window.startMs - duck.attackMs <= chunkOutputEndMs &&
        window.endMs + duck.attackMs >= chunkOutputStartMs,
    ),
  );
  if (!touches) return;
  for (let i = 0; i < chunk.length; i += 1) {
    const sampleOutputMs = chunkOutputStartMs + i * chunkMsPerSample;
    let gain = 1;
    for (const { windows, duck } of ducks) {
      gain *= duckGainAt(sampleOutputMs, windows, duck.depthDb, duck.attackMs);
    }
    if (gain === 1) continue;
    for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
      const destination = chunk.getChannelData(channel);
      // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, loop-bounded index, not attacker-controlled
      destination[i] = (destination[i] ?? 0) * gain;
    }
  }
}

/** D05's own fixed music-bed fade constants (`MusicTrackSchema`'s own doc
 * comment: "fade lengths are D05's own fixed constants (300 ms in / 800 ms
 * out), applied at mix time" — i.e. here, and identically in
 * `apps/render/src/ffmpeg/audio-mix.ts`), applied at the bed's own window
 * edges rather than per item like an `sfx` cue's `fadeInMs`/`fadeOutMs`. */
export const MUSIC_FADE_IN_MS = 300;
export const MUSIC_FADE_OUT_MS = 800;

/** A music bed's own asset-index lookup, wrapping when `loopPolicy` asks for
 * it and the asset is shorter than the bed's window. */
function musicAssetIndex(music: MusicMixCue, assetMs: number): number {
  const index = Math.round((assetMs / 1000) * music.buffer.sampleRate);
  if (music.loopPolicy !== "loop" || music.buffer.length === 0) return index;
  return ((index % music.buffer.length) + music.buffer.length) % music.buffer.length;
}

/** Adds one music bed's samples into `chunk`, in place — the same mechanism
 * as `mixSfxCueIntoChunk`, with D05's fixed 300ms/800ms fade pair at the
 * bed's own window edges instead of a per-item fade pair, and with
 * `loopPolicy`'s wraparound instead of a hard trim.
 *
 * A `loop` bed plays straight through the cuts (2026-10-04), as the cloud
 * render's does: one span on the output clock from its first retained piece
 * to its last, its asset position the time since that span began, faded at
 * the span's edges. `speechRanges` are on the output clock
 * ({@link outputSpeechRanges}). */
export function mixMusicCueIntoChunk(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  music: MusicMixCue,
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
): void {
  if (music.loopPolicy === "loop") {
    mixLoopedBedIntoChunk(chunk, chunkOutputStartMs, music, timemap, speechRanges);
    return;
  }
  const pieces = piecesFor(music.startMs, music.endMs, timemap);
  const gainLinear = dbToLinear(music.gainDb);
  const windowDurationMs = music.endMs - music.startMs;
  const chunkMsPerSample = 1000 / chunk.sampleRate;
  const chunkDurationMs = chunk.length * chunkMsPerSample;
  const chunkOutputEndMs = chunkOutputStartMs + chunkDurationMs;

  for (const piece of pieces) {
    const overlapStartMs = Math.max(chunkOutputStartMs, piece.outputStart);
    const overlapEndMs = Math.min(chunkOutputEndMs, piece.outputEnd);
    if (overlapEndMs <= overlapStartMs) continue;
    const assetPieceStartMs = piece.sourceStart - music.startMs;
    const isFirstPiece = Math.abs(assetPieceStartMs) < 0.5;
    const isLastPiece = Math.abs(piece.sourceEnd - music.startMs - windowDurationMs) < 0.5;

    for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
      const destination = chunk.getChannelData(channel);
      for (let i = 0; i < chunk.length; i += 1) {
        const sampleOutputMs = chunkOutputStartMs + i * chunkMsPerSample;
        if (sampleOutputMs < overlapStartMs || sampleOutputMs >= overlapEndMs) continue;

        const assetMs = sampleOutputMs - piece.outputStart + assetPieceStartMs;
        const assetIndex = musicAssetIndex(music, assetMs);
        let gain = gainLinear;
        if (isFirstPiece && assetMs < MUSIC_FADE_IN_MS) {
          gain *= Math.max(0, assetMs / MUSIC_FADE_IN_MS);
        }
        if (isLastPiece && assetMs > windowDurationMs - MUSIC_FADE_OUT_MS) {
          gain *= Math.max(0, (windowDurationMs - assetMs) / MUSIC_FADE_OUT_MS);
        }
        if (music.bedDuck !== null) {
          gain *= duckGainAt(
            sampleOutputMs,
            speechRanges,
            music.bedDuck.depthDb,
            music.bedDuck.attackMs,
          );
        }

        // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, loop-bounded index, not attacker-controlled
        destination[i] = (destination[i] ?? 0) + sampleAt(music.buffer, channel, assetIndex) * gain;
      }
    }
  }
}

/** A `loop` bed ({@link mixMusicCueIntoChunk}): one span on the output clock. */
function mixLoopedBedIntoChunk(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  music: MusicMixCue,
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
): void {
  const pieces = piecesFor(music.startMs, music.endMs, timemap).filter(
    (piece) => piece.outputEnd > piece.outputStart,
  );
  if (pieces.length === 0 || music.buffer.length === 0) return;
  const spanStartMs = Math.min(...pieces.map((piece) => piece.outputStart));
  const spanEndMs = Math.max(...pieces.map((piece) => piece.outputEnd));
  const spanMs = spanEndMs - spanStartMs;
  const gainLinear = dbToLinear(music.gainDb);
  const chunkMsPerSample = 1000 / chunk.sampleRate;
  const chunkOutputEndMs = chunkOutputStartMs + chunk.length * chunkMsPerSample;
  const overlapStartMs = Math.max(chunkOutputStartMs, spanStartMs);
  const overlapEndMs = Math.min(chunkOutputEndMs, spanEndMs);
  if (overlapEndMs <= overlapStartMs) return;

  for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
    const destination = chunk.getChannelData(channel);
    for (let i = 0; i < chunk.length; i += 1) {
      const sampleOutputMs = chunkOutputStartMs + i * chunkMsPerSample;
      if (sampleOutputMs < overlapStartMs || sampleOutputMs >= overlapEndMs) continue;
      const bedMs = sampleOutputMs - spanStartMs;
      let gain = gainLinear;
      if (bedMs < MUSIC_FADE_IN_MS) gain *= Math.max(0, bedMs / MUSIC_FADE_IN_MS);
      if (bedMs > spanMs - MUSIC_FADE_OUT_MS) {
        gain *= Math.max(0, (spanMs - bedMs) / MUSIC_FADE_OUT_MS);
      }
      if (music.bedDuck !== null) {
        gain *= duckGainAt(
          sampleOutputMs,
          speechRanges,
          music.bedDuck.depthDb,
          music.bedDuck.attackMs,
        );
      }
      const sample = sampleAt(music.buffer, channel, musicAssetIndex(music, bedMs));
      // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal, loop-bounded index, not attacker-controlled
      destination[i] = (destination[i] ?? 0) + sample * gain;
    }
  }
}

export function mixMusicCuesIntoChunk(
  chunk: AudioBuffer,
  chunkOutputStartMs: number,
  cues: readonly MusicMixCue[],
  timemap: TimeQuery | null,
  speechRanges: readonly SpeechRange[],
): void {
  for (const music of cues) {
    mixMusicCueIntoChunk(chunk, chunkOutputStartMs, music, timemap, speechRanges);
  }
}

export { SFX_DUCK_DB, SFX_DUCK_RAMP_MS };
