/**
 * The export engine (brief §3): Mediabunny input → WebCodecs decode →
 * CanvasKit caption compositing → WebCodecs encode → Mediabunny MP4 output.
 *
 * This module is the pipeline itself, deliberately free of `postMessage`
 * plumbing so it can be unit-tested against mocked WebCodecs/Mediabunny
 * globals in Node. `engine.worker.ts` is the thin Web Worker entry point that
 * calls `runExport` and forwards its progress callback and result over
 * `postMessage`; `worker-client.ts` is the main-thread side of that channel.
 * Splitting it this way is also what lets the same function serve the
 * Playwright e2e test directly (running it on the main thread there, since
 * Chromium's WebCodecs works identically on either) without a second
 * implementation to keep in sync.
 *
 * ## Frame loop
 *
 * 1. `Input`/`CanvasSink` (Mediabunny) decodes the source video and hands back
 *    a canvas already scaled+cropped to the output size (`fit: "cover"`) for
 *    each sampled source timestamp — see the deviation note below.
 * 2. `renderFrame` (`@montaj/render-core`) computes the same `DrawCommand[]`
 *    the cloud renderer would for that output millisecond, including the
 *    watermark when the manifest carries one (`applyManifestWatermark`).
 * 3. `CanvasKitBackend.drawFrame` rasterises those commands onto a transparent
 *    offscreen raster surface; the pixels are composited over the decoded
 *    frame with `putImageData`.
 * 4. The composited canvas goes into Mediabunny's `CanvasSource`, which
 *    encodes it with `VideoEncoder` and writes it to the `Output`.
 *
 * ## Deviation: cover-fit source, not `render-manifest`'s `coverScaleCrop`
 *
 * `packages/render-manifest`'s `coverScaleCrop` is the pixel-exact function the
 * cloud renderer's ffmpeg `scale`+`crop` pair uses. Reimplementing that same
 * arithmetic against Mediabunny's `CanvasSink` (which does its own `fit:
 * "cover"`) was out of reach in this pass; the two should agree to the pixel
 * for a centred cover fit (both scale until covering on both axes and crop the
 * overflow symmetrically) but this has not been proven bit-for-bit. Reported
 * as an open question in the final report — a follow-up should either call
 * `coverScaleCrop` directly and feed `CanvasSink` a matching `crop` rect, or
 * add a parity test between the two.
 *
 * ## Defensive loop
 *
 * Every `VideoFrame`/canvas handed back by a sink is used and released before
 * the next is requested — `CanvasSink`'s `WrappedCanvas` owns its own
 * lifetime, so there is no `VideoFrame.close()` to forget here the way there
 * would be against the raw WebCodecs `VideoDecoder` API. Backpressure comes
 * from awaiting `canvasSource.add()` before requesting the next frame (rather
 * than a hand-rolled in-flight counter), which keeps at most one frame's
 * worth of decode+composite+encode work in flight — well under
 * `DEFENSIVE_LIMITS.inFlight1080p`/`inFlight4k` — because Mediabunny's
 * `CanvasSource.add()` itself awaits `VideoEncoder.encode`'s backpressure
 * (`encodeQueueSize`) internally.
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  UrlSource,
} from "mediabunny";

import type { StyleDoc } from "@montaj/caption-styles";
import { CanvasKitBackend, createExportSurface } from "@montaj/render-canvaskit";
import {
  captionBoxFromLayouts,
  computeTrackShrink,
  createFontRegistry,
  createHarfBuzzShaper,
  layoutFrame,
  renderFrame,
  renderTitleFrame,
  sampleCropWindow,
  type CropKeyframe,
  type EdgProjection,
  type FontRegistry,
  type FontResource,
  type Shaper,
} from "@montaj/render-core";
import { coverScaleCrop, type RenderManifest } from "@montaj/render-manifest";
import type { TimeMap } from "@montaj/timemap";

import { mixSfxCuesIntoChunk, speechRangesFromWords, type SfxMixCue } from "./audio-mix";
import { decideAudioStrategy, isAudioUnmodified } from "./audio-strategy";
import { sha256Hex } from "./checksum";
import { outputCropKeyframesFromManifest } from "./keyframe-adapter";
import {
  createExportTarget,
  createMemoryTarget,
  type ExportTarget,
  type SaveFilePickerLike,
} from "./sink";
import { timeMapFromManifest } from "./timemap-adapter";
import { ExportCancelledError, type EngineProgress, type EngineResult } from "./types";

export interface RunExportOptions {
  readonly manifest: RenderManifest;
  /** URL (or Blob) Mediabunny reads the source video from — the proxy or original per manifest.source.bucket. */
  readonly source: string | Blob;
  /** Required when `manifest.audio.strategy === "replace"`. */
  readonly cleanAudioSource?: string | Blob;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: EngineProgress) => void;
  /**
   * Fetches the watermark PNG's bytes for `manifest.watermark.assetId`. No
   * client-facing endpoint returns a signed URL for a brand asset today (see
   * `README.md`'s "gaps reported" section) — the caller supplies whatever it
   * has; omitting it while the manifest carries a watermark is a hard error
   * (fail closed: the client never removes a watermark the manifest asked
   * for, and "silently drew the video without it" is indistinguishable from
   * removing it).
   */
  readonly fetchWatermarkAsset?: (assetId: string) => Promise<Uint8Array>;
  /**
   * Fetches one pack asset's bytes for an accepted `sfx`/`music` item's
   * `assetId` (the D04d signed-URL hook, `GET /audio-assets/{assetId}/url`) —
   * cached per asset by the caller. Unlike the watermark, omitting this while
   * the manifest carries accepted cues is not a hard error: a decorative cue
   * missing from an export is not the same risk class as a stripped
   * watermark, so those cues are silently skipped rather than failing the
   * whole export.
   */
  readonly fetchCueAsset?: (assetId: string) => Promise<Uint8Array>;
  /**
   * Decodes one cue asset's bytes to an `AudioBuffer`. Defaults to a scratch
   * `AudioContext`'s `decodeAudioData`; injectable for tests (jsdom has no
   * real Web Audio API).
   */
  readonly decodeCueAsset?: (bytes: Uint8Array) => Promise<AudioBuffer>;
  readonly target?: ExportTarget;
  readonly suggestedFileName?: string;
  readonly preferFileSystemAccess?: boolean;
  readonly saveFilePicker?: SaveFilePickerLike;
  /** AAC availability, decided by the probe; threaded through so the audio tree does not re-probe. */
  readonly aacEncodable: boolean;
  readonly aacPolyfillAvailable: boolean;
  /** Injectable for tests: builds the CanvasKit backend + font registry/shaper. Defaults to the browser loader. */
  readonly loadRenderer?: () => Promise<{ backend: CanvasKitBackend }>;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelledError();
}

/** Brief §4: 5 ms linear fades at cut boundaries, left unimplemented in A19b. */
export const SPLICE_FADE_MS = 5;

/**
 * Applies up to two linear gain ramps, in place, to one decoded audio chunk:
 * a fade-in from `chunkStartMs` (this chunk's offset within its retained
 * range) through `fadeInMs`, and a fade-out from `rangeDurationMs - fadeOutMs`
 * through the range's end. A chunk entirely inside the steady middle of a
 * range (the common case — most chunks are nowhere near a boundary) is left
 * untouched by the early-exit below rather than multiplying by a no-op 1.0
 * per sample.
 */
export function applySpliceFades(
  buffer: AudioBuffer,
  chunkStartMs: number,
  rangeDurationMs: number,
  fadeInMs: number,
  fadeOutMs: number,
): void {
  if (fadeInMs <= 0 && fadeOutMs <= 0) return;
  const chunkEndMs = chunkStartMs + (buffer.length / buffer.sampleRate) * 1000;
  const touchesFadeIn = fadeInMs > 0 && chunkStartMs < fadeInMs;
  const touchesFadeOut = fadeOutMs > 0 && chunkEndMs > rangeDurationMs - fadeOutMs;
  if (!touchesFadeIn && !touchesFadeOut) return;

  const msPerSample = 1000 / buffer.sampleRate;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const sampleMs = chunkStartMs + i * msPerSample;
      let gain = 1;
      if (fadeInMs > 0 && sampleMs < fadeInMs) {
        gain = Math.min(gain, Math.max(0, sampleMs / fadeInMs));
      }
      const msFromRangeEnd = rangeDurationMs - sampleMs;
      if (fadeOutMs > 0 && msFromRangeEnd < fadeOutMs) {
        gain = Math.min(gain, Math.max(0, msFromRangeEnd / fadeOutMs));
      }
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      if (gain < 1) data[i] = (data[i] ?? 0) * gain;
    }
  }
}

/**
 * SFX ducking (D04a; 09-ai-pipeline §6): −12 dB under speech, 150 ms ramps.
 *
 * An accepted `sfx` item's own gain (`payload.gainDb`, the pass's confidence-
 * scaled cue gain) is further attenuated by {@link SFX_DUCK_DB} whenever the
 * sample sits inside one of the transcript's speech ranges, so a cue landing
 * mid-sentence never fights the narration for headroom; outside every speech
 * range the cue plays at its own gain, unattenuated. The ramp is linear over
 * {@link SFX_DUCK_RAMP_MS} on both edges of a speech range so the duck is
 * inaudible as a click — the same reasoning `applySpliceFades` already
 * documents for splice boundaries.
 */
export const SFX_DUCK_DB = -12;
export const SFX_DUCK_RAMP_MS = 150;

/** `10^(db/20)` — linear amplitude from a decibel value. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * The duck gain (linear, 1 = no duck, `dbToLinear(duckDb)` = fully ducked) at
 * one instant, given the transcript's speech ranges. Ramps linearly over
 * `rampMs` as `tMs` crosses into or out of a range, so the curve is
 * continuous rather than a step.
 */
export function duckGainAt(
  tMs: number,
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
  duckDb: number = SFX_DUCK_DB,
  rampMs: number = SFX_DUCK_RAMP_MS,
): number {
  const duckedGain = dbToLinear(duckDb);
  let deepest = 1;

  for (const range of speechRanges) {
    // A trapezoid: unducked outside `[start - rampMs, end + rampMs]`, fully
    // ducked inside `[start + rampMs, end - rampMs]`, linear in between.
    // `distanceIn` is how far `tMs` sits from whichever *outer* transition
    // edge is nearer — 0 at either outer edge, growing symmetrically toward
    // both inner edges — so one formula covers both ramps and a range
    // shorter than `2 * rampMs` simply never reaches `2 * rampMs` of
    // distance, capping the duck short of the floor rather than crossing
    // through it twice.
    const outerStart = range.startMs - rampMs;
    const outerEnd = range.endMs + rampMs;
    if (tMs < outerStart || tMs > outerEnd) continue;

    const distanceIn = Math.max(0, Math.min(tMs - outerStart, outerEnd - tMs));
    const depth = Math.min(1, distanceIn / (2 * rampMs));
    const gain = 1 + depth * (duckedGain - 1);
    deepest = Math.min(deepest, gain);
  }

  return deepest;
}

/**
 * Applies {@link duckGainAt} sample-by-sample to one decoded SFX cue buffer,
 * in place. `cueStartMs` is the cue's own position on the finished timeline
 * (`PassItem.startMs`), so `speechRanges` — already in finished-timeline
 * coordinates (the transcript's own) — line up directly.
 */
export function applySfxDucking(
  buffer: AudioBuffer,
  cueStartMs: number,
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
  duckDb: number = SFX_DUCK_DB,
  rampMs: number = SFX_DUCK_RAMP_MS,
): void {
  if (speechRanges.length === 0) return;
  const msPerSample = 1000 / buffer.sampleRate;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const tMs = cueStartMs + i * msPerSample;
      const gain = duckGainAt(tMs, speechRanges, duckDb, rampMs);
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      if (gain < 1) data[i] = (data[i] ?? 0) * gain;
    }
  }
}

/** Overrides the projection's watermark with the manifest's own decision (orchestrator addendum). */
export function applyManifestWatermark(
  projection: EdgProjection,
  manifest: RenderManifest,
): EdgProjection {
  const watermarkAssetId = manifest.watermark?.assetId;
  return {
    ...projection,
    render: {
      ...projection.render,
      ...(watermarkAssetId === undefined ? {} : { watermarkAssetId }),
    },
  };
}

async function defaultLoadRenderer(): Promise<{ backend: CanvasKitBackend }> {
  const backend = await CanvasKitBackend.create({ locateFile: (file) => `/canvaskit/${file}` });
  return { backend };
}

function sourceOf(
  source: string | Blob,
): InstanceType<typeof BlobSource> | InstanceType<typeof UrlSource> {
  return source instanceof Blob ? new BlobSource(source) : new UrlSource(source);
}

/** `decodeCueAsset` default: a scratch `AudioContext`, used only to decode —
 * never connected to an output, closed the moment decoding is done. */
async function defaultDecodeCueAsset(bytes: Uint8Array): Promise<AudioBuffer> {
  const ctor =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (ctor === undefined) {
    throw new Error("no AudioContext available to decode a cue asset in this environment");
  }
  const context = new ctor();
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return await context.decodeAudioData(buffer);
  } finally {
    await context.close();
  }
}

/**
 * Decodes every accepted `sfx` cue's pack asset into an in-memory
 * `SfxMixCue`, one fetch+decode per distinct `assetId` (the same asset can
 * back more than one accepted cue). Returns `[]` when the manifest carries no
 * accepted `sfx` items, without requiring `fetchCueAsset` at all — the same
 * "only pay for what you use" shape `runExport`'s watermark/clean-audio paths
 * already follow.
 */
export async function decodeSfxCues(
  manifest: RenderManifest,
  fetchCueAsset: ((assetId: string) => Promise<Uint8Array>) | undefined,
  decodeCueAsset: (bytes: Uint8Array) => Promise<AudioBuffer>,
): Promise<SfxMixCue[]> {
  const tracks = manifest.timemap.audio?.sfx ?? [];
  if (tracks.length === 0) return [];
  if (fetchCueAsset === undefined) {
    throw new Error(
      "the manifest carries accepted sfx cues but no fetchCueAsset was supplied " +
        "(see GET /audio-assets/{assetId}/url) — render in the cloud instead.",
    );
  }
  const bufferByAssetId = new Map<string, Promise<AudioBuffer>>();
  const bufferFor = (assetId: string): Promise<AudioBuffer> => {
    let cached = bufferByAssetId.get(assetId);
    if (cached === undefined) {
      cached = fetchCueAsset(assetId).then(decodeCueAsset);
      bufferByAssetId.set(assetId, cached);
    }
    return cached;
  };
  return Promise.all(
    tracks.map(async (track) => ({
      itemId: track.itemId,
      startMs: track.startMs,
      endMs: track.endMs,
      gainDb: track.gainDb,
      fadeInMs: track.fadeInMs,
      fadeOutMs: track.fadeOutMs,
      duck: track.duck,
      buffer: await bufferFor(track.assetId),
    })),
  );
}

/** Runs the full pipeline. Resolves with the result; rejects with `ExportCancelledError` on cancellation. */
export async function runExport(options: RunExportOptions): Promise<EngineResult> {
  const { manifest, signal, onProgress, aacEncodable, aacPolyfillAvailable, fetchWatermarkAsset } =
    options;

  throwIfCancelled(signal);

  if (manifest.watermark !== null && fetchWatermarkAsset === undefined) {
    throw new Error(
      "manifest.watermark is set but no fetchWatermarkAsset was supplied; refusing to render " +
        "unwatermarked (the client never removes a watermark the manifest asked for).",
    );
  }

  const timemap: TimeMap | null =
    manifest.timemap.edits.length > 0 ? timeMapFromManifest(manifest) : null;
  const outputDurationMs = timemap?.outputDurationMs ?? manifest.timemap.sourceDurationMs;
  // B20: accepted zoom/reframe items' curves, already remapped onto the output
  // clock and pinned at every splice they cross. Empty when no such item is
  // accepted — `sampleCropWindow` then returns `null` and every frame draws
  // the full source, exactly today's behaviour.
  const cropKeyframes: CropKeyframe[] = outputCropKeyframesFromManifest(manifest, timemap);
  const fps = manifest.output.fps;
  const totalFrames = Math.max(1, Math.round((outputDurationMs / 1000) * fps));

  // D04e-2: every accepted `sfx` cue, decoded once up front — `applyManifestWatermark` and
  // the frame loop below do not touch audio, so this can run in parallel with everything
  // until the audio branch actually needs the buffers.
  const sfxCues = await decodeSfxCues(
    manifest,
    options.fetchCueAsset,
    options.decodeCueAsset ?? defaultDecodeCueAsset,
  );
  // Where speech actually is, on the source clock — the one duck curves (D04a) need.
  // `timemap` remaps the *cues*; the words the ranges are computed from are already on the
  // source clock.
  const speechRanges = speechRangesFromWords(
    options.projection.words,
    manifest.timemap.sourceDurationMs,
  );

  const projection = applyManifestWatermark(options.projection, manifest);

  const { backend } = await (options.loadRenderer ?? defaultLoadRenderer)();
  if (manifest.watermark !== null && fetchWatermarkAsset !== undefined) {
    const bytes = await fetchWatermarkAsset(manifest.watermark.assetId);
    backend.registerImage(manifest.watermark.assetId, bytes);
  }

  const trackShrink = computeTrackShrink({
    projection,
    catalogue: options.catalogue,
    registry: options.registry,
    shaper: options.shaper,
  });

  // D06b: accepted text-fx title items (`manifest.timemap.titles`), drawn
  // after every caption so a title always sits on top. Empty when no such
  // item is accepted, which keeps every export before D06b (and every export
  // whose manifest predates the field) exactly as it drew before.
  const titles = manifest.timemap.titles ?? [];
  const titleStyle =
    titles.length === 0 ? undefined : options.catalogue.get(projection.styles.defaultStyleId);

  const input = new Input({ source: sourceOf(options.source), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (videoTrack === null) throw new Error("the source has no video track");
  let audioTrack = await input.getPrimaryAudioTrack();

  // B10: "replace" points the encode path at the `ai.clean` output instead of
  // the source's own audio. The cleaned track has the same duration and content
  // timeline as the source (the worker never changes duration), so every
  // downstream consumer — `retainedSourceRangesMs`, the splice-fade math — stays
  // correct unmodified; only which track `AudioSampleSink` reads from changes.
  if (manifest.audio.strategy === "replace") {
    if (options.cleanAudioSource === undefined) {
      throw new Error(
        "the manifest asks for the cleaned audio track, but no cleanAudioSource was supplied " +
          "(see CreateExportResponse.sources.cleanedAudioUrl) — render in the cloud instead.",
      );
    }
    const cleanInput = new Input({
      source: sourceOf(options.cleanAudioSource),
      formats: ALL_FORMATS,
    });
    const cleanAudioTrack = await cleanInput.getPrimaryAudioTrack();
    if (cleanAudioTrack === null) {
      throw new Error("the cleaned audio source has no audio track — render in the cloud instead.");
    }
    audioTrack = cleanAudioTrack;
  }

  // A19b: use render-manifest's own `coverScaleCrop` (the pixel-exact
  // function the cloud renderer's ffmpeg scale+crop pair uses) rather than
  // Mediabunny's own `fit: "cover"`, so the two agree on the crop rectangle
  // rather than merely on the fitting strategy. `coverScaleCrop` computes the
  // crop in *scaled-up* target-space; `CanvasSink`'s `crop` option wants it in
  // *source* space (applied before resizing), so it is divided back by the
  // same scale factor before being handed over, then stretched to the exact
  // target box with `fit: "fill"`.
  const sourceDisplayWidth = await videoTrack.getDisplayWidth();
  const sourceDisplayHeight = await videoTrack.getDisplayHeight();
  const fit = coverScaleCrop(
    sourceDisplayWidth,
    sourceDisplayHeight,
    manifest.output.width,
    manifest.output.height,
  );
  const scale = fit.scaleWidth / sourceDisplayWidth;
  const canvasSink = new CanvasSink(videoTrack, {
    width: manifest.output.width,
    height: manifest.output.height,
    fit: "fill",
    crop: {
      left: fit.cropX / scale,
      top: fit.cropY / scale,
      width: fit.cropWidth / scale,
      height: fit.cropHeight / scale,
    },
  });

  const exportTarget =
    options.target ??
    (await createExportTarget(options.suggestedFileName ?? `export-${manifest.exportId}.mp4`, {
      ...(options.preferFileSystemAccess === undefined
        ? {}
        : { preferFileSystemAccess: options.preferFileSystemAccess }),
      ...(options.saveFilePicker === undefined ? {} : { global: options.saveFilePicker }),
    }));

  const output = new Output({ format: new Mp4OutputFormat(), target: exportTarget.target });

  const bitrate =
    manifest.output.width * manifest.output.height > 1920 * 1080 ? 35_000_000 : 8_000_000;
  const compositeCanvas = createCanvas(manifest.output.width, manifest.output.height);
  // "no-preference", not "prefer-hardware": a browser with no hardware H.264
  // encoder (this sandbox included — confirmed by testing) throws outright
  // on "prefer-hardware" instead of the graceful software fallback
  // "no-preference" gives. Portability over the last few percent of speed.
  const videoSource = new CanvasSource(compositeCanvas as unknown as HTMLCanvasElement, {
    codec: "avc",
    hardwareAcceleration: "no-preference",
    bitrate: new Quality({ bitrate }),
  });
  const ctx = compositeCanvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (ctx === null) throw new Error("could not get a 2d context for the composite canvas");

  output.addVideoTrack(videoSource);

  const audioDecision = decideAudioStrategy({ manifest, aacEncodable, aacPolyfillAvailable });
  let audioCopyTask: Promise<void> | undefined;
  if (audioDecision.kind === "copy" && audioTrack !== null) {
    const audioPacketSink = new EncodedPacketSink(audioTrack);
    const codecString = audioTrack.codec ?? "aac";
    const audioSource = new EncodedAudioPacketSource(codecString);
    output.addAudioTrack(audioSource);
    const decoderConfig = await audioTrack.getDecoderConfig();
    audioCopyTask = (async (): Promise<void> => {
      let packet = await audioPacketSink.getFirstPacket();
      let first = true;
      while (packet !== null) {
        throwIfCancelled(signal);
        // An AAC encoder's priming samples can leave the first packet(s) at a
        // slightly negative presentation timestamp (encoder delay); Mediabunny's
        // muxer rejects a negative timestamp outright, so clamp to zero rather
        // than drop audio at the very start of the track.
        const toAdd = packet.timestamp < 0 ? packet.clone({ timestamp: 0 }) : packet;
        // The first packet must carry the decoder config; Mediabunny throws
        // "Audio chunk metadata must be provided" without it.
        await audioSource.add(
          toAdd,
          first && decoderConfig !== null ? { decoderConfig } : undefined,
        );
        first = false;
        packet = await audioPacketSink.getNextPacket(packet);
      }
    })();
  } else if (
    (audioDecision.kind === "encode" || audioDecision.kind === "polyfill") &&
    audioTrack !== null
  ) {
    // A19b: a real resampled source for the common case (cuts against the
    // passthrough track). B10 (`audioTrack` reassignment above) supplies the
    // cleaned track for "replace" the same way; a "speed"/"hold" edit still
    // needs a resample rate this pass does not implement.
    if (manifest.timemap.edits.some((edit) => edit.kind !== "cut")) {
      throw new Error(
        "a speed change or freeze frame needs a resampled audio rate the browser path does " +
          "not implement yet — render in the cloud instead.",
      );
    }
    if (audioDecision.kind === "polyfill") {
      // Lazy-loaded per the brief: only paid for when the native encoder lacks AAC.
      await import("@mediabunny/aac-encoder");
    }
    const audioSource = new AudioBufferSource({
      codec: "aac",
      bitrate: new Quality({ bitrate: manifest.audio.bitrateKbps * 1000 }),
    });
    output.addAudioTrack(audioSource);
    const retainedRanges = retainedSourceRangesMs(
      manifest.timemap.sourceDurationMs,
      manifest.timemap.edits,
    );
    const audioSampleSink = new AudioSampleSink(audioTrack);
    audioCopyTask = (async (): Promise<void> => {
      // D04e-2: the running position on the *finished* (output) timeline,
      // across every range's chunks — unlike `elapsedMs` below (which resets
      // at each splice, for `applySpliceFades`'s own per-range maths), this
      // never resets, because a cue's own mapped pieces are expressed on that
      // same output clock (`mixSfxCuesIntoChunk`'s own doc comment).
      let outputClockMs = 0;
      for (const [rangeIndex, range] of retainedRanges.entries()) {
        throwIfCancelled(signal);
        // A19c (brief §4): a 5 ms linear fade at each splice boundary — the
        // join `retainedSourceRangesMs` creates between two ranges that used
        // to be separated by a cut. The outer edges of the whole track (the
        // very start of the first range, the very end of the last) are not
        // splices — nothing was cut there — so they are left at full gain;
        // only an edge that is adjacent to a removed range fades.
        const rangeDurationMs = range.endMs - range.startMs;
        const fadeInMs = rangeIndex === 0 ? 0 : Math.min(SPLICE_FADE_MS, rangeDurationMs / 2);
        const fadeOutMs =
          rangeIndex === retainedRanges.length - 1
            ? 0
            : Math.min(SPLICE_FADE_MS, rangeDurationMs / 2);
        let elapsedMs = 0;
        for await (const sample of audioSampleSink.samples(
          range.startMs / 1000,
          range.endMs / 1000,
        )) {
          throwIfCancelled(signal);
          try {
            const buffer = sample.toAudioBuffer();
            applySpliceFades(buffer, elapsedMs, rangeDurationMs, fadeInMs, fadeOutMs);
            if (sfxCues.length > 0) {
              mixSfxCuesIntoChunk(buffer, outputClockMs, sfxCues, timemap, speechRanges);
            }
            const chunkDurationMs = (buffer.length / buffer.sampleRate) * 1000;
            elapsedMs += chunkDurationMs;
            outputClockMs += chunkDurationMs;
            await audioSource.add(buffer);
          } finally {
            sample.close();
          }
        }
      }
    })();
  } else if (audioDecision.kind === "cloud-required") {
    throw new Error(audioDecision.reason);
  }

  await output.start();

  // A19c: a persistent surface, reused every frame (cleared, not recreated) —
  // the surface allocation itself is the expensive part of MakeSurface/
  // MakeWebGLCanvasSurface, and this is the loop A19b's throughput target
  // runs in. `createExportSurface` tries an OffscreenCanvas-backed WebGL
  // surface first (the highest-leverage throughput item A19b's README
  // flagged and did not attempt) and falls back to the CPU raster surface
  // A19b used exclusively — both are Skia, so `engine-parity.test.ts` proves
  // the pixels agree; only the speed differs.
  const { surface: captionSurface, backend: captionSurfaceBackend } = createExportSurface(
    backend.ck,
    manifest.output.width,
    manifest.output.height,
  );

  // A persistent scratch canvas the caption layer's pixels are
  // `putImageData`'d into (synchronous, no bitmap allocation), then
  // `drawImage`'d onto the composite canvas so the browser's own
  // compositor, not this code, does the alpha blending over the decoded
  // video frame.
  const captionCanvas2d = createCanvas(manifest.output.width, manifest.output.height);
  const captionCtx = captionCanvas2d.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (captionCtx === null) throw new Error("could not get a 2d context for the caption canvas");

  let framesDone = 0;
  const startedAt = Date.now();
  const frameDurationMs = 1000 / fps;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    throwIfCancelled(signal);
    const outputMs = frameIndex * frameDurationMs;
    const sourceMs = timemap === null ? outputMs : (timemap.toSource(outputMs) ?? outputMs);

    const wrapped = await canvasSink.getCanvas(sourceMs / 1000);
    if (wrapped !== null) {
      // B20: `wrapped.canvas` is already cover-fit to the output size (the
      // documented deviation above). A zoom/reframe crop window is applied as
      // a *second* crop on top of that cover-fit frame — sampling the window's
      // fraction of the already-fitted canvas and stretching it to fill the
      // output — rather than composed with the cover-fit's own source-pixel
      // crop math. That keeps every export with no accepted zoom/reframe item
      // (the overwhelming majority, and every export before B20) byte-identical
      // to today, at the cost of not being proven pixel-exact against the cloud
      // path's crop composition for the case where both a non-1:1 cover crop
      // and a zoom/reframe window are active at once — reported as an open
      // question in the final report, same category as the pre-existing
      // cover-fit deviation this note sits next to.
      const window = sampleCropWindow(cropKeyframes, outputMs);
      if (window === null) {
        ctx.drawImage(
          wrapped.canvas as CanvasImageSource,
          0,
          0,
          manifest.output.width,
          manifest.output.height,
        );
      } else {
        const canvasWidth = (wrapped.canvas as { width: number }).width;
        const canvasHeight = (wrapped.canvas as { height: number }).height;
        ctx.drawImage(
          wrapped.canvas as CanvasImageSource,
          window.x * canvasWidth,
          window.y * canvasHeight,
          window.w * canvasWidth,
          window.h * canvasHeight,
          0,
          0,
          manifest.output.width,
          manifest.output.height,
        );
      }
    }

    const commands = renderFrame({
      projection,
      timemap,
      catalogue: options.catalogue,
      registry: options.registry,
      shaper: options.shaper,
      outputMs,
      trackShrink,
    });

    if (titles.length > 0 && titleStyle !== undefined) {
      // The caption's own live safe area (D06 rule 2): `placeTitleBox` needs
      // it to keep a title clear of whatever caption is on screen this
      // frame, so `layoutFrame` (the same call `renderFrame` makes
      // internally) is re-run here for its geometry alone.
      const captionBox = captionBoxFromLayouts(
        layoutFrame({
          projection,
          timemap,
          catalogue: options.catalogue,
          registry: options.registry,
          shaper: options.shaper,
          outputMs,
          trackShrink,
        }),
      );
      commands.push(
        ...renderTitleFrame({
          titles,
          timemap,
          outputMs,
          canvas: projection.canvas,
          registry: options.registry,
          shaper: options.shaper,
          style: titleStyle,
          ...(captionBox === undefined ? {} : { captionBox }),
        }),
      );
    }

    if (commands.length > 0) {
      // A19b: raw pixel readback, not `renderToPng`'s PNG encode +
      // `createImageBitmap(Blob)`'s PNG decode. `readPixels` hands back the
      // raster surface's bytes directly; `putImageData` writes them into a
      // persistent scratch canvas synchronously (no bitmap allocation), and
      // `drawImage` composites that canvas over the decoded frame with the
      // browser's own alpha blending. The raster surface is cleared and
      // reused, not recreated, each frame.
      const captionCanvas = captionSurface.getCanvas();
      captionCanvas.clear(backend.ck.TRANSPARENT);
      backend.drawFrame(captionCanvas, commands, {});
      captionSurface.flush();
      const snapshot = captionSurface.makeImageSnapshot();
      try {
        const pixels = snapshot.readPixels(0, 0, {
          width: manifest.output.width,
          height: manifest.output.height,
          colorType: backend.ck.ColorType.RGBA_8888,
          alphaType: backend.ck.AlphaType.Unpremul,
          colorSpace: backend.ck.ColorSpace.SRGB,
        }) as Uint8Array | null;
        if (pixels !== null) {
          const imageData = new ImageData(
            new Uint8ClampedArray(pixels),
            manifest.output.width,
            manifest.output.height,
          );
          captionCtx.putImageData(imageData, 0, 0);
          ctx.drawImage(captionCanvas2d as CanvasImageSource, 0, 0);
        }
      } finally {
        snapshot.delete();
      }
    }

    await videoSource.add(outputMs / 1000, frameDurationMs / 1000);

    framesDone += 1;
    const elapsedMs = Date.now() - startedAt;
    const etaMs =
      framesDone > 0 ? Math.round((elapsedMs / framesDone) * (totalFrames - framesDone)) : null;
    onProgress({
      phase: "encoding",
      ratio: framesDone / totalFrames,
      framesDone,
      framesTotal: totalFrames,
      etaMs,
    });
  }

  captionSurface.delete();

  onProgress({
    phase: "muxing",
    ratio: 1,
    framesDone: totalFrames,
    framesTotal: totalFrames,
    etaMs: 0,
  });
  if (audioCopyTask !== undefined) await audioCopyTask;
  await output.finalize();

  const usedFileSystemAccess = exportTarget.kind === "file-system-access";
  const buffer = exportTarget.bufferAfterFinalize();
  const finished = buffer === null ? await exportTarget.readFinishedFile() : null;
  const finalBytes = buffer ?? finished?.bytes ?? null;
  const sizeBytes = finalBytes?.byteLength ?? 0;
  const checksum = finalBytes !== null ? await sha256Hex(finalBytes) : "";
  const encodeElapsedMs = Date.now() - startedAt;
  const realtimeMultiplier = encodeElapsedMs > 0 ? outputDurationMs / encodeElapsedMs : 0;

  onProgress({
    phase: "done",
    ratio: 1,
    framesDone: totalFrames,
    framesTotal: totalFrames,
    etaMs: 0,
  });

  return {
    sizeBytes,
    durationMs: outputDurationMs,
    checksum,
    usedFileSystemAccess,
    realtimeMultiplier,
    captionSurfaceBackend,
    ...(buffer !== null ? { blob: new Blob([buffer], { type: "video/mp4" }) } : {}),
  };
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export { createMemoryTarget };
export { isAudioUnmodified };

/** Registers the bundled fonts into a fresh registry/shaper pair (worker-side loader). */
export async function loadWorkerLayoutEngine(
  fonts: readonly FontResource[],
): Promise<{ registry: FontRegistry; shaper: Shaper }> {
  const registry = createFontRegistry(fonts);
  const shaper = await createHarfBuzzShaper(registry);
  return { registry, shaper };
}

/**
 * The complement of the manifest's `cut` edits within `[0, sourceDurationMs]`,
 * merged and sorted — the source ranges that survive into the output. Used
 * to re-buffer audio for a "cuts against the passthrough track" export:
 * feeding `AudioBufferSource.add` one retained range's samples after another
 * concatenates them with no gap, which is exactly what a cut removes.
 * Callers must have already refused any non-`cut` edit (`speed`/`hold`).
 */
export function retainedSourceRangesMs(
  sourceDurationMs: number,
  edits: readonly RenderManifest["timemap"]["edits"][number][],
): { startMs: number; endMs: number }[] {
  const cuts = edits
    .filter((edit): edit is Extract<typeof edit, { kind: "cut" }> => edit.kind === "cut")
    .map((edit) => ({
      startMs: Math.max(0, Math.min(edit.startMs, sourceDurationMs)),
      endMs: Math.max(0, Math.min(edit.endMs, sourceDurationMs)),
    }))
    .filter((edit) => edit.endMs > edit.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: { startMs: number; endMs: number }[] = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last !== undefined && cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs);
    } else {
      merged.push({ ...cut });
    }
  }

  const retained: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.startMs > cursor) retained.push({ startMs: cursor, endMs: cut.startMs });
    cursor = Math.max(cursor, cut.endMs);
  }
  if (cursor < sourceDurationMs) retained.push({ startMs: cursor, endMs: sourceDurationMs });
  return retained;
}
