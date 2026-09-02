/**
 * Assembles the unsigned `RenderManifest` (`@montaj/render-manifest`) from the
 * decision engine's verdict and the project's live state.
 *
 * Every field here is a **snapshot**: the EDG revision, the resolved style docs,
 * the timemap's edits and the source media key are all pinned at request time, so
 * a cloud job that sits in a queue while the project moves on still renders the
 * video that was asked for (`packages/render-manifest/README.md`).
 */

import { randomBytes } from "node:crypto";

import { ulid } from "ulid";

import { dimensionsFor } from "@montaj/render-manifest";
import type {
  Aspect,
  AudioStrategy,
  KeyframeTrack,
  OutputKind,
  RenderPreset,
  SubtitleFormat,
  SubtitleScript,
  TimemapEdit,
  UnsignedRenderManifest,
  Watermark,
  WatermarkPosition,
} from "@montaj/render-manifest";

import type { ExportDecision } from "./decision.js";
import type { StyleSnapshotResolution } from "./projection.js";
import type { Aspect as PrismaAspect } from "@prisma/client";

/** `@montaj/render-core`'s version at the time this manifest was signed. */
export const RENDER_CORE_VERSION = "0.1.0";

/**
 * The bundled Free-tier watermark's asset id (`packages/render-manifest`'s own
 * fixture uses the same constant). Its bytes ship with the render surfaces —
 * `apps/render` and the browser exporter — the way a fallback font pack does;
 * it is not a `brand_assets` row because it belongs to no single workspace.
 */
export const DEFAULT_WATERMARK_ASSET_ID = "aksharo-watermark";

const DEFAULT_WATERMARK_POSITION: WatermarkPosition = "bottom-right";
const DEFAULT_WATERMARK_OPACITY = 0.85;

/** How long an issued manifest stays valid: long enough for a queued cloud job
 * to be picked up and for a browser export to finish, short enough to bound a
 * leaked manifest's usefulness. */
export const MANIFEST_TTL_MS = 2 * 60 * 60_000;

const ASPECT_FROM_PRISMA: Record<PrismaAspect, Aspect> = {
  r9x16: "9:16",
  r16x9: "16:9",
  r1x1: "1:1",
  r4x5: "4:5",
};

export interface BuildManifestInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly exportId: string;
  readonly edg: {
    readonly edgId: string;
    readonly revision: number;
    readonly transcriptId?: string;
  };
  readonly styleSnapshot: StyleSnapshotResolution;
  readonly source: {
    readonly mediaId: string;
    readonly bucket: "raw" | "derived";
    readonly key: string;
    readonly durationMs: number;
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
  };
  readonly timemapEdits: readonly TimemapEdit[];
  /**
   * B20: accepted zoom/reframe items' packed curves. Optional and unwired by
   * this work package (needs B19's keyframe-bytes storage) — the call site is
   * `exports.service.ts`'s `requestExport`, alongside its existing
   * `timemapEdits: [...timeMap.edits]` line.
   */
  readonly keyframeTracks?: readonly KeyframeTrack[];
  readonly outputDurationMs: number;
  readonly decision: ExportDecision;
  readonly kind: "video" | "subtitle";
  readonly outputKind: OutputKind;
  readonly preset: RenderPreset;
  readonly customWidth?: number;
  readonly customHeight?: number;
  readonly projectAspect: PrismaAspect;
  readonly subtitleFormats?: readonly SubtitleFormat[];
  readonly subtitleScripts?: readonly SubtitleScript[];
  readonly dropFillers?: boolean;
  /** A workspace's own logo, deliberately overlaid even on an unwatermarked export. */
  readonly brandWatermark?: {
    readonly assetId: string;
    readonly position: WatermarkPosition;
    readonly opacity: number;
  };
  readonly now?: number;
  /**
   * B10: the succeeded `ai.clean` run to mux instead of the source track, when
   * `EdgHot.audio.clean.enabled` is set for this project. `undefined` (the EDG
   * default) keeps the manifest at `strategy: "passthrough"`, exactly A21b's
   * prior behaviour.
   */
  readonly audioClean?: { readonly cleanId: string; readonly cleanKey: string };
}

export interface BuiltManifest {
  readonly manifest: UnsignedRenderManifest;
  readonly manifestId: string;
  readonly nonce: string;
}

function outputDimensions(input: BuildManifestInput): {
  width: number;
  height: number;
  aspect: Aspect;
} {
  const dims = dimensionsFor(input.preset);
  if (dims !== null) return dims;
  const width = Math.max(16, input.customWidth ?? 1_080);
  const height = Math.max(16, input.customHeight ?? 1_920);
  return { width, height, aspect: ASPECT_FROM_PRISMA[input.projectAspect] };
}

function audioStrategyFor(outputKind: OutputKind, hasClean: boolean): AudioStrategy {
  // A caption-only layer (alpha/green-screen) carries no soundtrack of its own —
  // the editor drops it over the source's audio in their NLE.
  if (outputKind === "alpha" || outputKind === "greenscreen") return "none";
  // B10: a project with a clean applied (`EdgHot.audio.clean.enabled`) replaces
  // the source track with the `ai.clean` output on both render paths — `apps/render`'s
  // ffmpeg graph (`ffmpeg/graph.ts`) and `apps/web/lib/export/engine.ts` already
  // read `audio.strategy === "replace"` plus `cleanKey`/`cleanId`; this is what
  // sets them.
  return hasClean ? "replace" : "passthrough";
}

function watermarkFor(input: BuildManifestInput): Watermark | null {
  if (input.decision.watermark) {
    return {
      assetId: DEFAULT_WATERMARK_ASSET_ID,
      position: DEFAULT_WATERMARK_POSITION,
      opacity: DEFAULT_WATERMARK_OPACITY,
    };
  }
  if (input.brandWatermark !== undefined) return input.brandWatermark;
  return null;
}

/** Build (but do not sign) the manifest for one export request. */
export function buildRenderManifest(input: BuildManifestInput): BuiltManifest {
  const now = input.now ?? Date.now();
  const manifestId = ulid();
  const nonce = randomBytes(24).toString("hex");
  const output = outputDimensions(input);
  const fps = Math.min(input.source.fps ?? 30, input.decision.maxFps);

  const manifest: UnsignedRenderManifest = {
    v: 1,
    manifestId,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MANIFEST_TTL_MS).toISOString(),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    exportId: input.exportId,
    edg: {
      edgId: input.edg.edgId,
      revision: input.edg.revision,
      ...(input.edg.transcriptId === undefined ? {} : { transcriptId: input.edg.transcriptId }),
    },
    styles: {
      defaultStyleId: input.styleSnapshot.defaultStyleId,
      catalogueSnapshotIds: [...input.styleSnapshot.catalogueSnapshotIds],
      ...(input.styleSnapshot.documentOverrides === undefined
        ? {}
        : { documentOverrides: input.styleSnapshot.documentOverrides }),
    },
    source: {
      mediaId: input.source.mediaId,
      bucket: input.source.bucket,
      key: input.source.key,
      durationMs: input.source.durationMs,
      ...(input.source.width === undefined ? {} : { width: input.source.width }),
      ...(input.source.height === undefined ? {} : { height: input.source.height }),
      ...(input.source.fps === undefined ? {} : { fps: input.source.fps }),
    },
    timemap: {
      sourceDurationMs: input.source.durationMs,
      edits: [...input.timemapEdits],
      ...(input.source.fps === undefined ? {} : { fps: input.source.fps }),
      snapCutsToFrames: false,
      // B20: accepted zoom/reframe curves. Left empty here — populating it from
      // `edg.passes` items needs B19's keyframe-bytes storage/fetch, which is
      // outside this file's ownership (A21) and not yet available when this was
      // written; see the B20 final report for the exact follow-up call site.
      keyframes: input.keyframeTracks ? [...input.keyframeTracks] : [],
    },
    output: {
      kind: input.outputKind,
      preset: input.preset,
      aspect: output.aspect,
      width: output.width,
      height: output.height,
      fps,
      container: input.outputKind === "alpha" ? "mov" : "mp4",
      videoCodec: input.outputKind === "alpha" ? "prores4444" : "h264",
      ...(input.outputKind === "alpha"
        ? {}
        : { crf: output.width >= 2_560 ? 18 : 20, encoderPreset: "veryfast" }),
      ...(input.outputKind === "greenscreen" ? { chromaKey: "#00FF00" } : {}),
    },
    audio: {
      strategy: audioStrategyFor(input.outputKind, input.audioClean !== undefined),
      ...(input.audioClean === undefined
        ? {}
        : { cleanId: input.audioClean.cleanId, cleanKey: input.audioClean.cleanKey }),
      codec: "aac",
      bitrateKbps: 192,
    },
    watermark: watermarkFor(input),
    caps: {
      maxWidth: input.decision.maxWidth,
      maxHeight: input.decision.maxHeight,
      maxDurationMs: input.decision.maxDurationMs,
      maxFps: input.decision.maxFps,
      allowAlpha: input.decision.allowAlpha,
    },
    subtitles:
      input.kind === "subtitle"
        ? {
            formats: [...(input.subtitleFormats ?? ["srt"])],
            scripts: [...(input.subtitleScripts ?? ["roman"])],
            dropFillers: input.dropFillers ?? false,
          }
        : null,
    renderCoreVersion: RENDER_CORE_VERSION,
  };

  return { manifest, manifestId, nonce };
}
