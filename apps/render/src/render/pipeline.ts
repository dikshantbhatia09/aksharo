/**
 * One cloud render, start to finish, with every dependency injected.
 *
 * The order is the security order, not the convenience one:
 *
 * 1. **verify the manifest** — signature, then clock. Nothing is downloaded for
 *    a job whose instructions do not verify;
 * 2. **build the timemap**, because the caps are about the *rendered* length and
 *    that is not known until the cuts are applied;
 * 3. **check the caps** — refused here, before a byte of media moves, so a 4K
 *    request on a 1080p plan costs nothing;
 * 4. download, probe, render, encode, upload.
 *
 * Everything the process touches — the object stores, the clock, the encoder —
 * arrives as a parameter, so the integration test is the same code path as
 * production with different objects passed in.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarfBuzzShaper, outputCropKeyframesFromTracks } from "@montaj/render-core";
import { assertWithinCaps, verifyRenderManifest } from "@montaj/render-manifest";
import type { RenderManifest } from "@montaj/render-manifest";
import { SkiaNodeBackend } from "@montaj/render-skia-node";

import { loadFonts } from "./fonts.js";
import {
  createFrameSource,
  createPooledFrameSource,
  type FrameSource,
  type FrameStats,
} from "./frames.js";
import { assertPartnerGrantForTrack, type VerifyPartnerGrant } from "./partner-grant.js";
import { createRasterPool, defaultPoolSize, type RasterPool } from "./pool.js";
import { buildRenderTimeMap, parseStyleCatalogue, toEdgProjection } from "./projection.js";
import { watermarkCommandFor } from "./watermark.js";
import { speechRangesFromWords, type MusicMixCue, type SfxMixCue } from "../ffmpeg/audio-mix.js";
import { runEncode } from "../ffmpeg/encode.js";
import { buildFfmpegArgs, type VideoEncoder } from "../ffmpeg/graph.js";
import { probeAudioAsset, probeMedia } from "../ffmpeg/probe.js";
import { brandAssetKey, contentTypeFor, exportKey, type ObjectStore } from "../storage.js";

import type { RenderVideoPayload } from "../queues.js";

export interface RenderDependencies {
  /** S3: the raw originals. */
  readonly rawStore: ObjectStore;
  /** R2: the derived objects and every export (D35). */
  readonly derivedStore: ObjectStore;
  readonly secret: string;
  readonly secretNext?: string | undefined;
  readonly encoder: VideoEncoder;
  /**
   * Rasteriser threads. `undefined` takes `min(cores − 1, 4)`; `0` rasterises
   * inline on this thread, which is also where a machine without worker threads
   * ends up.
   */
  readonly rasterWorkers?: number | undefined;
  readonly fontDir?: string | undefined;
  readonly workDir?: string | undefined;
  readonly ffmpegLogLevel?: string;
  /** Called at most every `progressIntervalMs`; posts the heartbeat. */
  readonly onProgress?: (fraction: number, message: string) => void;
  readonly progressIntervalMs?: number;
  readonly onWarning?: (message: string) => void;
  /**
   * Reads the bytes of a brand asset. Defaults to R2 under
   * `ws/{workspaceId}/brand/{assetId}.png`; injected in tests and available to a
   * deployment that keeps the platform mark somewhere else.
   */
  readonly resolveBrandAsset?: (assetId: string) => Promise<Uint8Array>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Overrides the rasteriser worker entry point; a test points it elsewhere. */
  readonly workerPath?: string | undefined;
  /**
   * D04b2 scope §4: verifies a partner-catalogue grant before a partner
   * asset's pack object is downloaded. Undefined behaves exactly like a
   * verification that always returns `false` (fail closed) — see
   * `partner-grant.ts`'s `assertPartnerGrantForTrack`.
   */
  readonly verifyPartnerGrant?: VerifyPartnerGrant;
}

export interface RenderOutcome {
  readonly manifest: RenderManifest;
  readonly outputKey: string;
  readonly sizeBytes: number;
  readonly outputDurationMs: number;
  readonly frames: FrameStats;
  readonly wallClockMs: number;
  readonly ffmpegSummary: string;
  readonly filterGraph: string;
  readonly fontSource: "pack" | "fixtures";
  /** Threads that actually rasterised; `0` when it ran inline. */
  readonly rasterWorkers: number;
}

/** Renders one `render.video` job. */
export async function renderVideo(
  payload: RenderVideoPayload,
  workspaceId: string,
  dependencies: RenderDependencies,
): Promise<RenderOutcome> {
  const startedAt = Date.now();
  const now = dependencies.now ?? Date.now;

  // 1. The manifest, before anything else touches the network.
  const { manifest } = verifyRenderManifest({
    manifest: payload.manifest,
    secret: dependencies.secret,
    secretNext: dependencies.secretNext,
    now: now(),
  });
  if (manifest.workspaceId !== workspaceId) {
    throw new Error(
      `the manifest is for workspace ${manifest.workspaceId}, but the job is for ${workspaceId}`,
    );
  }

  // 2. The timemap, so the caps see the rendered length and not the source's.
  const timemap = buildRenderTimeMap(manifest);

  // 3. Entitlement. Refused before a byte of media moves.
  assertWithinCaps(manifest, timemap.outputDurationMs);

  const scratch = await mkdtemp(join(dependencies.workDir ?? tmpdir(), "montaj-render-"));
  try {
    // 4. Media in.
    const sourceStore =
      manifest.source.bucket === "raw" ? dependencies.rawStore : dependencies.derivedStore;
    const sourcePath = join(scratch, `source${extensionOf(manifest.source.key)}`);
    await sourceStore.download(manifest.source.key, sourcePath);

    let cleanAudioPath: string | null = null;
    if (manifest.audio.strategy === "replace" && manifest.audio.cleanKey !== undefined) {
      cleanAudioPath = join(scratch, `clean${extensionOf(manifest.audio.cleanKey)}`);
      await dependencies.derivedStore.download(manifest.audio.cleanKey, cleanAudioPath);
    }

    // D04e: every accepted `sfx` cue's pack asset, downloaded once per job to
    // the scratch dir the graph's extra `-i` inputs will read from. The pack
    // library lives in the derived bucket (`apps/api/src/audio-assets/
    // README.md`'s "upload to the derived bucket"), the same store the clean
    // audio track above comes from.
    const sfxTracks = manifest.timemap.audio?.sfx ?? [];
    const sfxCues: SfxMixCue[] = [];
    for (const track of sfxTracks) {
      await assertPartnerGrantForTrack(track, workspaceId, dependencies.verifyPartnerGrant);
      const localPath = join(scratch, `sfx-${track.itemId}${extensionOf(track.storageKey)}`);
      await dependencies.derivedStore.download(track.storageKey, localPath);
      sfxCues.push({
        itemId: track.itemId,
        startMs: track.startMs,
        endMs: track.endMs,
        gainDb: track.gainDb,
        fadeInMs: track.fadeInMs,
        fadeOutMs: track.fadeOutMs,
        duck: track.duck,
        localPath,
      });
    }
    // D04e-4: every accepted `music` bed's pack asset, downloaded the same
    // way as an `sfx` cue's — `manifest.timemap.audio.music[]` is D05's own
    // additive field (`packages/render-manifest`'s `MusicTrackSchema`).
    // `assetDurationMs` (needed to decide whether/how much `buildMusicFilters`
    // loops a bed) comes from probing the downloaded file itself, since a
    // pack asset's own duration is not carried on the manifest track.
    const musicTracks = manifest.timemap.audio?.music ?? [];
    const musicCues: MusicMixCue[] = [];
    for (const track of musicTracks) {
      await assertPartnerGrantForTrack(track, workspaceId, dependencies.verifyPartnerGrant);
      const localPath = join(scratch, `music-${track.itemId}${extensionOf(track.storageKey)}`);
      await dependencies.derivedStore.download(track.storageKey, localPath);
      const assetProbe = await probeAudioAsset(localPath);
      musicCues.push({
        itemId: track.itemId,
        startMs: track.startMs,
        endMs: track.endMs,
        gainDb: track.gainDb,
        loopPolicy: track.loopPolicy,
        bedDuck: track.bedDuck,
        localPath,
        assetDurationMs: assetProbe.durationMs,
      });
    }

    // Where speech actually is, on the source clock — the one duck curves
    // (D04a) need. `timemap` (built next) remaps the *cues*; the words the
    // ranges are computed from are already on the source clock, so this can
    // run before the timemap exists.
    const speechRanges = speechRangesFromWords(
      payload.projection.words,
      manifest.timemap.sourceDurationMs,
    );

    const probe = await probeMedia(sourcePath);
    dependencies.onProgress?.(0.02, "source ready");

    // 5. The drawing side.
    const fonts = await loadFonts({
      directory: dependencies.fontDir,
      ...(dependencies.onWarning === undefined ? {} : { onWarning: dependencies.onWarning }),
    });
    const shaper = await createHarfBuzzShaper(fonts.registry);
    const backend = await SkiaNodeBackend.create({ shaper });
    const images: { assetId: string; bytes: Uint8Array }[] = [];
    if (manifest.watermark !== null) {
      // A watermark the manifest asked for and the store cannot supply must fail
      // the render. Drawing the frame without it would turn a missing file into
      // a free unwatermarked export, which is the wrong way round (T10).
      const resolve =
        dependencies.resolveBrandAsset ??
        ((assetId: string) =>
          dependencies.derivedStore.getBytes(brandAssetKey(manifest.workspaceId, assetId)));
      const bytes = await resolve(manifest.watermark.assetId);
      // Both rasterisers need it: the inline backend here, and every worker in
      // the pool, which has its own Skia and its own image table.
      images.push({ assetId: manifest.watermark.assetId, bytes });
      await backend.registerImage(manifest.watermark.assetId, bytes);
    }

    // Every overlay is transparent: `overlay` composites it onto the decoded
    // source, and the green ground of a green-screen export is ffmpeg's `color`
    // source rather than a fill on this side.
    // 6. The encode.
    const outputPath = join(scratch, `export.${manifest.output.container}`);
    // B20: accepted zoom/reframe curves, decoded and remapped onto the output
    // clock the same way the browser exporter does (`outputCropKeyframesFromTracks`
    // is the one shared implementation both call).
    const cropKeyframes = outputCropKeyframesFromTracks(manifest.timemap.keyframes ?? [], timemap);
    const plan = buildFfmpegArgs({
      manifest,
      sourcePath: manifest.output.kind === "alpha" ? null : sourcePath,
      cleanAudioPath,
      sourceWidth: probe.displayWidth,
      sourceHeight: probe.displayHeight,
      sourceHasAudio: probe.audio !== null,
      spans: timemap.spans,
      outputDurationMs: timemap.outputDurationMs,
      outputPath,
      encoder: dependencies.encoder,
      ...(cropKeyframes.length === 0 ? {} : { cropKeyframes }),
      ...(sfxCues.length === 0 && musicCues.length === 0
        ? {}
        : { sfxCues, musicCues, timemap, speechRanges }),
      ...(dependencies.ffmpegLogLevel === undefined
        ? {}
        : { logLevel: dependencies.ffmpegLogLevel }),
    });

    // The frame source, once the frame count is known.
    //
    // The pool is tried first and the inline path is the fallback, not the
    // other way round: a machine without worker threads, or an image missing
    // the worker entry, must still render — just at A20's speed.
    const styleCatalogue = parseStyleCatalogue(payload.styles);
    const projectionForFrames = toEdgProjection(payload.projection, manifest);
    // D06b: accepted text-fx title items, drawn after every caption. Empty
    // when the manifest carries none, which keeps every render from before
    // D06b (and every manifest that predates the field) unchanged.
    const titles = manifest.timemap.titles ?? [];
    const titleStyle =
      titles.length === 0
        ? undefined
        : styleCatalogue.get(projectionForFrames.styles.defaultStyleId);

    const commandOptions = {
      projection: projectionForFrames,
      timemap,
      catalogue: styleCatalogue,
      registry: fonts.registry,
      shaper,
      fps: manifest.output.fps,
      watermark: watermarkCommandFor(manifest.watermark, {
        width: manifest.output.width,
        height: manifest.output.height,
      }),
      script: payload.script,
      dropFillers: payload.dropFillers,
      titles,
      ...(titleStyle === undefined ? {} : { titleStyle }),
    };

    const wantedWorkers = dependencies.rasterWorkers ?? defaultPoolSize();
    let pool: RasterPool | null = null;
    if (wantedWorkers > 0) {
      try {
        pool = await createRasterPool({
          width: manifest.output.width,
          height: manifest.output.height,
          fonts: fonts.fonts,
          images,
          size: wantedWorkers,
          onMissing: (resource) => {
            dependencies.onWarning?.(`a rasteriser worker could not find ${resource}`);
          },
          ...(dependencies.workerPath === undefined ? {} : { workerPath: dependencies.workerPath }),
        });
      } catch (error) {
        dependencies.onWarning?.(
          `rasterising inline: the worker pool did not start (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }

    const pooled =
      pool === null
        ? null
        : createPooledFrameSource({ ...commandOptions, pool, frames: plan.overlayFrames });
    const frames: FrameSource =
      pooled ??
      createFrameSource({
        ...commandOptions,
        backend,
        batch: backend.createBatch({
          width: manifest.output.width,
          height: manifest.output.height,
        }),
      });

    const interval = dependencies.progressIntervalMs ?? 5_000;
    let lastReport = Date.now();
    await runEncode({
      args: plan.args,
      frames: plan.overlayFrames,
      frame: (index) => frames.frame(index),
      onFrameConsumed: (index) => {
        frames.consumed?.(index);
      },
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      onProgress: (fraction) => {
        const at = Date.now();
        if (at - lastReport < interval) return;
        lastReport = at;
        // 2% for the download, 90% for the frames, the rest for the upload.
        dependencies.onProgress?.(
          0.02 + fraction * 0.9,
          `${String(Math.round(fraction * 100))}% of ${String(plan.overlayFrames)} frames`,
        );
      },
    });

    await pooled?.close();

    // 7. Media out, to R2 under CONTRACTS §6.
    const key = exportKey(
      manifest.workspaceId,
      manifest.projectId,
      manifest.exportId,
      manifest.output.container,
    );
    const sizeBytes = await dependencies.derivedStore.upload(key, outputPath, {
      contentType: contentTypeFor(manifest.output.container),
    });
    dependencies.onProgress?.(1, "uploaded");

    backend.dispose();

    return {
      manifest,
      outputKey: key,
      sizeBytes,
      outputDurationMs: timemap.outputDurationMs,
      frames: frames.stats,
      wallClockMs: Date.now() - startedAt,
      ffmpegSummary: plan.summary,
      filterGraph: plan.filterGraph,
      fontSource: fonts.source,
      rasterWorkers: pool?.size ?? 0,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function extensionOf(key: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  return match?.[1] === undefined ? ".bin" : `.${match[1].toLowerCase()}`;
}
