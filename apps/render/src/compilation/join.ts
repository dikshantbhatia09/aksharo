/**
 * One `render.compilation` job, start to finish (2026-10-03), every dependency
 * injected so the integration test is this code with a directory for a store.
 *
 * 1. **Hold the payload to the job.** Every clip must be an export of the
 *    job's own workspace; the output goes to the payload's project under the
 *    job's workspace. Refused before anything is read.
 * 2. **Fetch and measure.** Each clip's captioned video is downloaded to the
 *    job's scratch folder and probed: its picture's length decides its frames,
 *    and a part with no sound is given silence. A joined video past the cap
 *    (the clips were longer than their exports said) is refused.
 * 3. **The title card**, when there is one: drawn by Skia (`card.ts`) and
 *    encoded as the first part.
 * 4. **The pieces, then the join** (`plan.ts`): at most two inputs per ffmpeg
 *    run, whatever the number of clips, and a clip's file is deleted once its
 *    last piece is made, so disk use stays near one clip plus the pieces.
 * 5. **Upload** to the export key, and report what was made.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";
import { createHarfBuzzShaper } from "@montaj/render-core";
import { SkiaNodeBackend } from "@montaj/render-skia-node";

import { cardFrames } from "./card.js";
import {
  cardArgs,
  concatArgs,
  concatList,
  fadeFramesFor,
  framesOf,
  lastUse,
  pieceArgs,
  pieceFrames,
  planPieces,
  totalFrames,
  type PartSource,
  type PieceOptions,
} from "./plan.js";
import { runFfmpeg } from "./run-ffmpeg.js";
import { runEncode } from "../ffmpeg/encode.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { loadFonts } from "../render/fonts.js";
import { extensionOfFormat } from "../render/overlay-images.js";
import { brandAssetKey, exportKey, StorageError, type ObjectStore } from "../storage.js";

import type { RenderCompilationPayload, RenderCompilationResult } from "../queues.js";

/** The longest joined video: the API's cap, and a little for rounding. */
export const MAX_COMPILATION_MS = 15 * 60_000 + 5_000;

/** The caption style whose typeface a card without its own is set in. */
export const CARD_STYLE_ID = "punch-pop";

export class CompilationError extends Error {
  public override readonly name = "CompilationError";
  constructor(
    readonly code: "render/compilation-too-long" | "render/no-video-stream" | "storage/bad-key",
    message: string,
  ) {
    super(message);
  }
}

export interface CompilationDependencies {
  /** R2: the clips' captioned videos, the brand logo, and where the result goes. */
  readonly derivedStore: ObjectStore;
  readonly fontDir?: string | undefined;
  readonly workDir?: string | undefined;
  readonly ffmpegPath?: string;
  /** x264 threads per piece; four keeps a 1080 x 1920 piece near 400 MB. */
  readonly encoderThreads?: number;
  readonly ffmpegLogLevel?: string;
  readonly onProgress?: (fraction: number, message: string) => void;
  readonly onWarning?: (message: string) => void;
  readonly signal?: AbortSignal;
  /** The card's fallback style; the system catalogue's {@link CARD_STYLE_ID} by default. */
  readonly style?: StyleDoc;
}

export interface CompilationOutcome {
  readonly result: RenderCompilationResult;
  readonly frames: number;
  readonly pieces: number;
  readonly wallClockMs: number;
}

/** Makes one compilation ({@link CompilationOutcome}); see the module comment for the order. */
export async function renderCompilation(
  payload: RenderCompilationPayload,
  workspaceId: string,
  dependencies: CompilationDependencies,
): Promise<CompilationOutcome> {
  const startedAt = Date.now();
  const { fps, width, height } = payload;
  const progress = dependencies.onProgress ?? ((): void => undefined);

  // 1. Only this workspace's exports, and only into this workspace.
  for (const clip of payload.clips) {
    if (!clip.key.startsWith(`ws/${workspaceId}/`)) {
      throw new CompilationError(
        "storage/bad-key",
        `clip ${clip.clipId}'s video is not in this job's workspace`,
      );
    }
  }
  const outputKey = exportKey(workspaceId, payload.projectId, payload.exportId, "mp4");

  const options: PieceOptions = {
    width,
    height,
    fps,
    encoderThreads: dependencies.encoderThreads ?? 4,
    ...(dependencies.ffmpegLogLevel === undefined ? {} : { logLevel: dependencies.ffmpegLogLevel }),
  };
  const run = (args: readonly string[], timeoutMs: number): Promise<void> =>
    runFfmpeg(args, {
      timeoutMs,
      ...(dependencies.ffmpegPath === undefined ? {} : { ffmpegPath: dependencies.ffmpegPath }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });

  const scratch = await mkdtemp(join(dependencies.workDir ?? tmpdir(), "montaj-compilation-"));
  try {
    // 2. The clips, fetched and measured.
    const parts: PartSource[] = [];
    for (const [index, clip] of payload.clips.entries()) {
      const path = join(scratch, `clip-${String(index)}${extensionOf(clip.key)}`);
      await dependencies.derivedStore.download(clip.key, path);
      const probe = await probeMedia(path);
      if (probe.video === null) {
        throw new CompilationError(
          "render/no-video-stream",
          `clip ${clip.clipId}'s video has no picture`,
        );
      }
      const lengthMs = probe.video.durationMs ?? probe.durationMs;
      parts.push({
        path,
        frames: Math.max(1, framesOf(lengthMs, fps)),
        hasAudio: probe.audio !== null,
      });
      progress(
        0.02 + (0.08 * (index + 1)) / payload.clips.length,
        `fetched clip ${String(index + 1)}`,
      );
    }

    // 3. The title card, as the first part.
    if (payload.intro !== undefined) {
      const card = await makeCard(payload, workspaceId, scratch, options, dependencies);
      parts.unshift(card);
      progress(0.12, "title card drawn");
    }

    const counts = parts.map((part) => part.frames);
    const fade = fadeFramesFor(framesOf(payload.fadeMs, fps), counts);
    const frames = totalFrames(counts, fade);
    const outputMs = Math.round((frames * 1000) / fps);
    if (outputMs > MAX_COMPILATION_MS) {
      throw new CompilationError(
        "render/compilation-too-long",
        `the clips come to ${String(Math.round(outputMs / 1000))} s, past the ${String(MAX_COMPILATION_MS / 60_000)}-minute cap`,
      );
    }

    // 4. The pieces, then the join.
    const pieces = planPieces(counts, fade);
    const last = lastUse(pieces, parts.length);
    const made: { file: string; frames: number }[] = [];
    let done = 0;
    for (const [index, piece] of pieces.entries()) {
      const file = `piece-${String(index).padStart(3, "0")}.mov`;
      const count = pieceFrames(piece);
      // Generous: a piece is seconds of video, and a stuck ffmpeg must not hold the node.
      await run(pieceArgs(piece, parts, join(scratch, file), options), 120_000 + count * 200);
      made.push({ file, frames: count });
      done += count;
      progress(0.12 + (0.83 * done) / frames, `joined ${String(done)} of ${String(frames)} frames`);
      // A clip read for the last time is not needed on disk any more.
      for (const [part, lastPiece] of last.entries()) {
        const path = parts.at(part)?.path;
        if (lastPiece === index && path !== undefined) await rm(path, { force: true });
      }
    }

    const listPath = join(scratch, "pieces.ffconcat");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside the job's own scratch folder, not input
    await writeFile(listPath, concatList(made, fps), "utf8");
    const outputPath = join(scratch, "compilation.mp4");
    await run(concatArgs(listPath, outputPath, options), 600_000);
    progress(0.97, "joined");

    const measured = await probeMedia(outputPath);
    const measuredMs = measured.video?.durationMs ?? measured.durationMs;
    if (Math.abs(measuredMs - outputMs) > 1_000 / fps + 50) {
      dependencies.onWarning?.(
        `the joined video measures ${String(measuredMs)} ms against the ${String(outputMs)} ms planned`,
      );
    }

    // 5. Filed as the export.
    const sizeBytes = await dependencies.derivedStore.upload(outputKey, outputPath, {
      contentType: "video/mp4",
    });
    progress(1, "uploaded");

    return {
      result: {
        schemaVersion: 1,
        compilationId: payload.compilationId,
        exportId: payload.exportId,
        outputKey,
        outputMs,
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside the job's own scratch folder, not input
        sizeBytes: sizeBytes > 0 ? sizeBytes : (await stat(outputPath)).size,
        width,
        height,
        fps,
        clips: payload.clips.length,
        intro: payload.intro !== undefined,
      },
      frames,
      pieces: pieces.length,
      wallClockMs: Date.now() - startedAt,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/**
 * Draws and encodes the title card (`card.ts`) as a part of its own. The logo
 * is read from the job's workspace; one that cannot be read is left off the
 * card with a warning rather than failing the compilation.
 */
async function makeCard(
  payload: RenderCompilationPayload,
  workspaceId: string,
  scratch: string,
  options: PieceOptions,
  dependencies: CompilationDependencies,
): Promise<PartSource> {
  const intro = payload.intro;
  if (intro === undefined) throw new RangeError("no title card was asked for");
  const fonts = await loadFonts({
    directory: dependencies.fontDir,
    ...(dependencies.onWarning === undefined ? {} : { onWarning: dependencies.onWarning }),
  });
  const shaper = await createHarfBuzzShaper(fonts.registry);
  const backend = await SkiaNodeBackend.create({ shaper });
  try {
    let withLogo = false;
    if (intro.logo !== undefined) {
      try {
        const bytes = await dependencies.derivedStore.getBytes(
          brandAssetKey(workspaceId, intro.logo.assetId, extensionOfFormat(intro.logo.format)),
        );
        await backend.registerImage(intro.logo.assetId, bytes);
        withLogo = true;
      } catch (error) {
        if (error instanceof StorageError && error.code === "storage/bad-key") throw error;
        dependencies.onWarning?.(
          `the title card is drawn without its logo, which could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const style = dependencies.style ?? cardStyle();
    const frames = cardFrames({
      intro,
      width: options.width,
      height: options.height,
      fps: options.fps,
      style,
      registry: fonts.registry,
      shaper,
      backend,
      withLogo,
    });
    const path = join(scratch, "card.mov");
    await runEncode({
      args: cardArgs(frames.count, path, options),
      frames: frames.count,
      frame: (index) => frames.frame(index),
      ...(dependencies.ffmpegPath === undefined ? {} : { ffmpegPath: dependencies.ffmpegPath }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });
    return { path, frames: frames.count, hasAudio: true };
  } finally {
    backend.dispose();
  }
}

/** The product's default caption style, or any style the catalogue has. */
function cardStyle(): StyleDoc {
  const styles = loadSystemStyleMap();
  const style = styles.get(CARD_STYLE_ID) ?? styles.values().next().value;
  if (style === undefined) throw new Error("no caption style is installed to set the card in");
  return style;
}

function extensionOf(key: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  return match?.[1] === undefined ? ".mp4" : `.${match[1].toLowerCase()}`;
}
