import { createHash, randomBytes } from "node:crypto";

import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { type Env } from "@montaj/config";
import { type VideoShape } from "@montaj/repurpose-contracts";

import {
  buildNleTimeline,
  readMeText,
  timelineSrt,
  toFcpxml,
  toXmeml,
  type NleNames,
} from "./nle-timeline.js";
import { safeSegment } from "./run-bundle.files.js";
import { zipLayout, zipStream, type ZipEntry } from "./zip-writer.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { redisKeyPrefix } from "../../common/redis/redis-keys.js";
import { RedisService } from "../../common/redis/redis.service.js";
import {
  DERIVED_STORE,
  keyBelongsToWorkspace,
  type ObjectStore,
} from "../../common/storage/index.js";
import { ENV } from "../../config/config.module.js";
import { EdgRepository } from "../../edg/edg.repository.js";
import { ASPECT_OF_SHAPE, REPURPOSE_ERRORS } from "../repurpose.constants.js";
import { cleanSourceTitle } from "../repurpose.projection.js";
import { ClipReviewService } from "../review/clip-review.service.js";
import { isRemoved } from "../steering.js";

import type { RunBundleDownload } from "./run-bundle.service.js";

/**
 * "For your editing app" (2026-10-01, OpusClip parity: their "Export XML"):
 * one clip in one shape as a ZIP a Premiere Pro, Final Cut Pro or DaVinci
 * Resolve editor opens -
 *
 *     <Clip> 9x16 for editing/
 *       <Clip> 9x16.mp4             the clean cut, no captions burned in
 *       <Clip> 9x16.fcpxml          Final Cut Pro, DaVinci Resolve (captions as titles)
 *       <Clip> 9x16 Premiere.xml    Premiere Pro (Final Cut Pro 7 XML)
 *       <Clip> 9x16.srt             the captions, on the timeline's clock
 *       Read me.txt
 *
 * The timeline files are written from the shape project's editing document at
 * the moment of the download (`nle-timeline.ts` has the rules), so an edit made
 * in Aksharo's editor a minute ago is in it; nothing is stored.
 *
 * Delivered exactly like "Download all" (`run-bundle.service.ts`), whose
 * pieces it reuses: a signed-in member asks for a single-use, five-minute URL
 * (a browser download cannot carry a bearer token), only the token's SHA-256
 * is kept in Redis and it is spent on first use; the ZIP is streamed (STORE,
 * `zip-writer.ts`) with the clean cut read from the derived store as it is
 * sent, never written to disk, with an exact `Content-Length`. One clip is a
 * few tens of megabytes, so there is no per-workspace limit of its own.
 *
 * Anyone who can see the run's clips (viewers and up) can already download the
 * clean cut and the captions; this is the same files, arranged for an editor.
 */
export const NLE_TOKEN_TTL_SECONDS = 5 * 60;

/** An open download: the response's name and length, and the bytes. */
export interface OpenedNleDownload {
  readonly filename: string;
  readonly totalBytes: number;
  readonly files: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

interface TokenClaims {
  readonly workspaceId: string;
  readonly runId: string;
  readonly clipId: string;
  readonly userId: string;
  readonly shape: VideoShape;
}

/** Everything one download is made of, read before a byte is sent. */
export interface NlePackage {
  readonly folder: string;
  /** The clean cut in the derived store. */
  readonly mediaKey: string;
  readonly names: NleNames;
  /** The text files, by name inside the folder. */
  readonly texts: readonly { readonly name: string; readonly text: string }[];
  readonly captions: number;
  readonly edits: number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class ClipNleDownloadService {
  private readonly logger = new Logger(ClipNleDownloadService.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly reviews: ClipReviewService,
    private readonly audit: CommonAuditService,
    private readonly edg: EdgRepository,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A single-use URL for the browser to download the clip's editing package
   * from. 404 for a clip not of this run (or removed); 409
   * `repurpose/nle_not_ready` while the shape has no clean cut or captions
   * document yet.
   */
  async createDownload(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    shape: VideoShape,
  ): Promise<RunBundleDownload> {
    await this.reviews.assertAvailable(workspaceId);
    // Checked now, so the person hears "not ready" on the page, not from a
    // download that fails.
    await this.packageOf(workspaceId, runId, clipId, shape);
    const token = randomBytes(32).toString("base64url");
    const claims: TokenClaims = { workspaceId, runId, clipId, userId, shape };
    await this.redis.client.set(
      tokenKey(token),
      JSON.stringify(claims),
      "EX",
      NLE_TOKEN_TTL_SECONDS,
    );
    return {
      url: new URL(`/repurpose/nle-downloads/${token}`, this.env.API_ORIGIN).toString(),
      expiresAt: new Date(this.now() + NLE_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * The ZIP behind a token, spending it. 404 `repurpose/download_expired` for
   * a token unknown, spent or past its five minutes.
   */
  async open(token: string): Promise<OpenedNleDownload> {
    const claims = TOKEN_PATTERN.test(token) ? await this.spend(token) : null;
    if (claims === null) {
      throw new AppException(
        REPURPOSE_ERRORS.downloadExpired,
        "This download link has expired. Start the download again from the clip.",
        HttpStatus.NOT_FOUND,
      );
    }
    await this.reviews.assertAvailable(claims.workspaceId);
    const pack = await this.packageOf(
      claims.workspaceId,
      claims.runId,
      claims.clipId,
      claims.shape,
    );
    const head = await this.derived.head(pack.mediaKey).catch(() => null);
    if (head === null) throw notReady();

    const modified = new Date(this.now());
    const entries: ZipEntry[] = [
      {
        name: `${pack.folder}/${pack.names.mediaFile}`,
        size: head.sizeBytes,
        modified: head.lastModified ?? modified,
        open: () => this.read(pack.mediaKey),
      },
      ...pack.texts.map((file) => {
        const bytes = Buffer.from(file.text, "utf8");
        return {
          name: `${pack.folder}/${file.name}`,
          size: bytes.length,
          modified,
          open: () => once(bytes),
        };
      }),
    ];
    const totalBytes = zipLayout(entries).totalBytes;
    await this.audit.record({
      action: "repurpose.clip.nle_downloaded",
      resource: "repurpose_clip",
      resourceId: claims.clipId,
      actorId: claims.userId,
      workspaceId: claims.workspaceId,
      data: {
        runId: claims.runId,
        shape: claims.shape,
        bytes: totalBytes,
        captions: pack.captions,
        edits: pack.edits,
      },
    });

    const logger = this.logger;
    const stream = (async function* () {
      try {
        yield* zipStream(entries);
      } catch (error) {
        logger.warn(
          { clipId: claims.clipId, err: error instanceof Error ? error.message : String(error) },
          "a clip's editing download stopped part way",
        );
        throw error;
      }
    })();
    return { filename: `${pack.folder}.zip`, totalBytes, files: entries.length, stream };
  }

  /**
   * The clip's editing package in one shape: its clean cut's key and the
   * timeline, caption and read-me files written from its document.
   */
  async packageOf(
    workspaceId: string,
    runId: string,
    clipId: string,
    shape: VideoShape,
  ): Promise<NlePackage> {
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId, run: { workspaceId } },
      select: {
        title: true,
        candidate: { select: { state: true } },
        run: { select: { sourceTitle: true, sourceProject: { select: { title: true } } } },
      },
    });
    if (clip === null || isRemoved(clip.candidate)) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that clip.",
        HttpStatus.NOT_FOUND,
      );
    }
    const variant = await this.prisma.clipVariant.findFirst({
      // eslint-disable-next-line security/detect-object-injection -- `shape` is a validated VideoShape
      where: { clipId, aspect: ASPECT_OF_SHAPE[shape] },
      select: { projectId: true },
    });
    if (variant === null) throw notReady();
    const [project, media] = await Promise.all([
      this.prisma.project.findFirst({
        where: { id: variant.projectId, workspaceId, deletedAt: null },
        select: { edgDocument: { select: { id: true } } },
      }),
      this.prisma.mediaAsset.findFirst({
        where: {
          projectId: variant.projectId,
          role: "primary",
          status: "ready",
          derivedPurgedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: {
          storageKey: true,
          durationMs: true,
          fps: true,
          width: true,
          height: true,
          hasAudio: true,
        },
      }),
    ]);
    const edgId = project?.edgDocument?.id;
    if (
      edgId === undefined ||
      media === null ||
      media.storageKey === "" ||
      media.durationMs === null ||
      media.durationMs <= 0
    ) {
      throw notReady();
    }
    if (!keyBelongsToWorkspace(media.storageKey, workspaceId)) {
      this.logger.warn(
        { workspaceId },
        "a clip's editing download refused a key outside its workspace",
      );
      throw notReady();
    }

    const document = await this.edg.projectionOf(edgId);
    const chunks = await this.edg.loadChunks(document.transcript.transcriptId);
    const timeline = buildNleTimeline({
      durationMs: media.durationMs,
      fps: media.fps,
      width: media.width ?? document.canvas.width,
      height: media.height ?? document.canvas.height,
      hasAudio: media.hasAudio !== false,
      passItems: document.passes.flatMap((pass) => pass.items),
      segments: document.segments,
      chunks,
    });
    if (timeline.items.length === 0) throw notReady();

    const runTitle =
      cleanSourceTitle(clip.run.sourceTitle) ??
      cleanSourceTitle(clip.run.sourceProject.title) ??
      "Clips";
    const stem = `${safeSegment(clip.title, 60, "Clip")} ${shape.replace(":", "x")}`;
    const names: NleNames = {
      project: stem,
      event: safeSegment(runTitle, 80, "Clips"),
      mediaFile: `${stem}.mp4`,
    };
    const files = {
      fcpxml: `${stem}.fcpxml`,
      xmeml: `${stem} Premiere.xml`,
      srt: `${stem}.srt`,
    };
    return {
      folder: `${stem} for editing`,
      mediaKey: media.storageKey,
      names,
      texts: [
        { name: files.fcpxml, text: toFcpxml(timeline, names) },
        { name: files.xmeml, text: toXmeml(timeline, names) },
        { name: files.srt, text: timelineSrt(timeline) },
        { name: "Read me.txt", text: readMeText(names, files) },
      ],
      captions: timeline.captions.length,
      edits: timeline.items.length - 1,
    };
  }

  // -------------------------------------------------------------------------

  private async spend(token: string): Promise<TokenClaims | null> {
    const raw = await this.redis.client.getdel(tokenKey(token));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<TokenClaims>;
      return typeof parsed.workspaceId === "string" &&
        typeof parsed.runId === "string" &&
        typeof parsed.clipId === "string" &&
        typeof parsed.userId === "string" &&
        typeof parsed.shape === "string" &&
        parsed.shape in ASPECT_OF_SHAPE
        ? (parsed as TokenClaims)
        : null;
    } catch {
      return null;
    }
  }

  private async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    if (this.derived.openRead === undefined) {
      throw new Error("this store cannot stream objects");
    }
    const { body } = await this.derived.openRead(key);
    return chunksOf(body);
  }
}

function notReady(): AppException {
  return new AppException(
    REPURPOSE_ERRORS.nleNotReady,
    "This clip is not ready to open in an editing app yet. Try again when it is made.",
    HttpStatus.CONFLICT,
  );
}

async function* once(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

function tokenKey(token: string): string {
  return `${redisKeyPrefix()}:repurpose:nle-download:v1:${createHash("sha256").update(token).digest("hex")}`;
}

/** A web stream's chunks; cancelling the read (the browser went away) closes it. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
