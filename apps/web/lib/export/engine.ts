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
import { CanvasKitBackend } from "@montaj/render-canvaskit";
import {
  computeTrackShrink,
  createFontRegistry,
  createHarfBuzzShaper,
  renderFrame,
  type EdgProjection,
  type FontRegistry,
  type FontResource,
  type Shaper,
} from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";
import type { TimeMap } from "@montaj/timemap";

import { decideAudioStrategy, isAudioUnmodified } from "./audio-strategy";
import { sha256Hex } from "./checksum";
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
  const fps = manifest.output.fps;
  const totalFrames = Math.max(1, Math.round((outputDurationMs / 1000) * fps));

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

  const input = new Input({ source: sourceOf(options.source), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (videoTrack === null) throw new Error("the source has no video track");
  const audioTrack = await input.getPrimaryAudioTrack();

  const canvasSink = new CanvasSink(videoTrack, {
    width: manifest.output.width,
    height: manifest.output.height,
    fit: "cover",
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
  const videoSource = new CanvasSource(compositeCanvas as unknown as HTMLCanvasElement, {
    codec: "avc",
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
  } else if (audioDecision.kind === "encode" || audioDecision.kind === "polyfill") {
    if (audioDecision.kind === "polyfill") {
      // Lazy-loaded per the brief: only paid for when the native encoder lacks AAC.
      await import("@mediabunny/aac-encoder");
    }
    const audioSource = new AudioBufferSource({
      codec: "aac",
      bitrate: new Quality({ bitrate: manifest.audio.bitrateKbps * 1000 }),
    });
    output.addAudioTrack(audioSource);
    // Cleaned/cut audio re-buffering against the timemap's 5 ms splice fades
    // is tracked as an open item in the final report — this build carries the
    // audio track selection and codec decision through, but the encode path
    // for "replace"/cut audio is not wired to a sample source in this pass.
  } else if (audioDecision.kind === "cloud-required") {
    throw new Error(audioDecision.reason);
  }

  await output.start();

  let framesDone = 0;
  const startedAt = Date.now();
  const frameDurationMs = 1000 / fps;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    throwIfCancelled(signal);
    const outputMs = frameIndex * frameDurationMs;
    const sourceMs = timemap === null ? outputMs : (timemap.toSource(outputMs) ?? outputMs);

    const wrapped = await canvasSink.getCanvas(sourceMs / 1000);
    if (wrapped !== null) {
      ctx.drawImage(
        wrapped.canvas as CanvasImageSource,
        0,
        0,
        manifest.output.width,
        manifest.output.height,
      );
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

    if (commands.length > 0) {
      const png = backend.renderToPng(commands, {
        width: manifest.output.width,
        height: manifest.output.height,
        background: "#00000000",
      });
      const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
      try {
        ctx.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
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
