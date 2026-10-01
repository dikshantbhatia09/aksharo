import { createHash, randomBytes } from "node:crypto";

import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { type Env } from "@montaj/config";

import {
  bundleFilesOf,
  safeSegment,
  type BundleCompilation,
  type BundleFile,
} from "./run-bundle.files.js";
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
import { cleanCutsOf, dubFilesOf, episodePackOf, runClipsOf } from "../guest/clip-files.reader.js";
import { planGuestClip } from "../guest/guest-files.js";
import { REPURPOSE_ERRORS, SHAPE_OF_ASPECT } from "../repurpose.constants.js";
import { cleanSourceTitle } from "../repurpose.projection.js";
import { ClipReviewService } from "../review/clip-review.service.js";
import { NOT_REQUIRED } from "../review/review-state.js";
import { reviewVideosOf } from "../review/review-videos.js";

/**
 * "Download all" (2026-10-01): every clip of a run, in every shape, with its
 * images, its words to post and its dubbed versions - and the run's
 * compilations and episode text - as one ZIP (`run-bundle.files.ts` decides
 * what goes where).
 *
 * **Streamed, never stored.** The archive is written as it is sent, each file
 * read from the derived store when its turn comes (`zip-writer.ts`): nothing is
 * held in memory or written to a disk that already holds the media. This is
 * the second place bytes pass through the API (after publishing,
 * `ObjectStore.openRead`): a ZIP has to be put together somewhere, and here it
 * costs no disk and starts at once.
 *
 * **Its size is known before it starts**, from each object's `HEAD`, so the
 * response carries `Content-Length` and the browser shows progress and time
 * left. A file gone between the sizing and the read ends the download (the
 * browser says it failed; starting again sizes afresh).
 *
 * **A browser cannot put a bearer token on a download**, so the run page asks
 * for one (`createDownload`, a signed-in member of the workspace) and gets a
 * URL holding a random single-use token: 256 bits, kept in Redis only as its
 * SHA-256, deleted on first use, gone after {@link DOWNLOAD_TOKEN_TTL_SECONDS}.
 * A request log that records the URL records a spent token.
 *
 * At most {@link MAX_DOWNLOADS_PER_WORKSPACE} at once per workspace: each holds
 * a connection to the store and one through the tunnel for its whole length.
 */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 5 * 60;
export const MAX_DOWNLOADS_PER_WORKSPACE = 2;
/** Objects sized at once. */
const HEAD_CONCURRENCY = 12;

export interface RunBundleSummary {
  /** Clips with files in the ZIP. */
  readonly clips: number;
  /** Clips with nothing finished yet, so not in it. */
  readonly clipsComing: number;
  /** Captioned videos: every shape of every clip, and the compilations. */
  readonly videos: number;
  readonly dubbedVideos: number;
  readonly images: number;
  /** Words to post and the episode text. */
  readonly texts: number;
  /** The ZIP's size as offered: captioned videos and everything else, no clean cuts. */
  readonly bytes: number;
  /** Clean cuts "Also without captions" adds. */
  readonly cleanVideos: number;
  /** The ZIP's size with them. */
  readonly bytesWithClean: number;
  readonly filename: string;
}

export interface RunBundleDownload {
  /** The single-use URL to send the browser to. */
  readonly url: string;
  readonly expiresAt: string;
}

/** An open download: the response's name and length, and the bytes. */
export interface OpenedRunBundle {
  readonly filename: string;
  readonly totalBytes: number;
  readonly files: number;
  readonly stream: AsyncIterable<Uint8Array>;
  /**
   * Frees the download's place in the workspace's limit. The stream does it
   * when it ends; the caller does it too (it is idempotent), since a stream
   * dropped before its first read never runs its own ending.
   */
  readonly release: () => void;
}

interface TokenClaims {
  readonly workspaceId: string;
  readonly runId: string;
  readonly userId: string;
  readonly includeClean: boolean;
  /** Only these clips (2026-10-01); absent for every clip. */
  readonly clipIds?: readonly string[];
}

interface SizedFile {
  readonly file: BundleFile;
  readonly size: number;
  readonly modified: Date;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class RunBundleService {
  private readonly logger = new Logger(RunBundleService.name);
  private readonly active = new Map<string, number>();

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly reviews: ClipReviewService,
    private readonly audit: CommonAuditService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * What the ZIP would hold, with and without the clean cuts, and how big it
   * is: of every clip, or of the clips picked.
   */
  async summary(
    workspaceId: string,
    runId: string,
    clipIds?: readonly string[],
  ): Promise<RunBundleSummary> {
    await this.reviews.assertAvailable(workspaceId);
    const content = await this.contentOf(workspaceId, runId, true, clipIds);
    const sized = await this.sized(workspaceId, content.files);
    const offered = sized.filter((entry) => !entry.file.optional);
    const count = (kind: BundleFile["kind"]): number =>
      offered.filter((entry) => entry.file.kind === kind).length;
    return {
      clips: content.clips,
      clipsComing: content.clipsComing,
      videos: count("video") + count("compilation"),
      dubbedVideos: count("dub"),
      images: count("image"),
      texts: count("text"),
      bytes: layoutBytes(offered),
      cleanVideos: sized.length - offered.length,
      bytesWithClean: layoutBytes(sized),
      filename: content.filename,
    };
  }

  /** A single-use URL for the browser to download the ZIP from. */
  async createDownload(
    workspaceId: string,
    userId: string,
    runId: string,
    input: { readonly includeClean: boolean; readonly clipIds?: readonly string[] | undefined },
  ): Promise<RunBundleDownload> {
    await this.reviews.assertAvailable(workspaceId);
    const content = await this.contentOf(workspaceId, runId, input.includeClean, input.clipIds);
    if (content.files.length === 0) {
      throw new AppException(
        REPURPOSE_ERRORS.nothingToDownload,
        "No clip of this video is finished yet.",
        HttpStatus.CONFLICT,
      );
    }
    const token = randomBytes(32).toString("base64url");
    const claims: TokenClaims = {
      workspaceId,
      runId,
      userId,
      includeClean: input.includeClean,
      ...(input.clipIds === undefined ? {} : { clipIds: [...input.clipIds] }),
    };
    await this.redis.client.set(
      tokenKey(token),
      JSON.stringify(claims),
      "EX",
      DOWNLOAD_TOKEN_TTL_SECONDS,
    );
    return {
      url: new URL(`/repurpose/downloads/${token}`, this.env.API_ORIGIN).toString(),
      expiresAt: new Date(this.now() + DOWNLOAD_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * The ZIP behind a download token, spending the token. 404
   * `repurpose/download_expired` for a token unknown, spent or past its five
   * minutes; 429 while the workspace has its most downloads running.
   */
  async open(token: string): Promise<OpenedRunBundle> {
    const claims = TOKEN_PATTERN.test(token) ? await this.spend(token) : null;
    if (claims === null) {
      throw new AppException(
        REPURPOSE_ERRORS.downloadExpired,
        "This download link has expired. Start the download again from the video's page.",
        HttpStatus.NOT_FOUND,
      );
    }
    await this.reviews.assertAvailable(claims.workspaceId);
    const content = await this.contentOf(
      claims.workspaceId,
      claims.runId,
      claims.includeClean,
      claims.clipIds,
    );
    const sized = await this.sized(claims.workspaceId, content.files);
    if (sized.length === 0) {
      throw new AppException(
        REPURPOSE_ERRORS.nothingToDownload,
        "No clip of this video is finished yet.",
        HttpStatus.CONFLICT,
      );
    }

    // Checked and taken with nothing awaited in between: two downloads
    // starting at once must not both see a free place.
    const running = this.active.get(claims.workspaceId) ?? 0;
    if (running >= MAX_DOWNLOADS_PER_WORKSPACE) {
      throw new AppException(
        REPURPOSE_ERRORS.downloadsBusy,
        "Two downloads are already running for this workspace. Try again when one finishes.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.active.set(claims.workspaceId, running + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (this.active.get(claims.workspaceId) ?? 1) - 1;
      if (left <= 0) this.active.delete(claims.workspaceId);
      else this.active.set(claims.workspaceId, left);
    };

    const entries: ZipEntry[] = sized.map(({ file, size, modified }) => ({
      name: file.path,
      size,
      modified,
      open: () => this.read(file),
    }));
    const totalBytes = zipLayout(entries).totalBytes;
    await this.audit.record({
      action: "repurpose.run.downloaded",
      resource: "repurpose_run",
      resourceId: claims.runId,
      actorId: claims.userId,
      workspaceId: claims.workspaceId,
      data: {
        files: entries.length,
        bytes: totalBytes,
        includeClean: claims.includeClean,
        ...(claims.clipIds === undefined ? {} : { clips: content.clips }),
      },
    });

    const logger = this.logger;
    const stream = (async function* () {
      try {
        yield* zipStream(entries);
      } catch (error) {
        logger.warn(
          { runId: claims.runId, err: error instanceof Error ? error.message : String(error) },
          "a run download stopped part way",
        );
        throw error;
      } finally {
        release();
      }
    })();
    return { filename: content.filename, totalBytes, files: entries.length, stream, release };
  }

  // -------------------------------------------------------------------------

  private async spend(token: string): Promise<TokenClaims | null> {
    const raw = await this.redis.client.getdel(tokenKey(token));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<TokenClaims>;
      return typeof parsed.workspaceId === "string" &&
        typeof parsed.runId === "string" &&
        typeof parsed.userId === "string" &&
        typeof parsed.includeClean === "boolean" &&
        (parsed.clipIds === undefined ||
          (Array.isArray(parsed.clipIds) &&
            parsed.clipIds.every((id: unknown) => typeof id === "string")))
        ? (parsed as TokenClaims)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Every file of the run's ZIP, and its clips counted. With `clipIds`, only
   * those clips (ids not of this run are ignored), and nothing that belongs to
   * the whole video rather than to a clip (compilations, episode text); the
   * ZIP's name says how many clips it holds.
   */
  private async contentOf(
    workspaceId: string,
    runId: string,
    includeClean: boolean,
    clipIds?: readonly string[],
  ): Promise<{
    readonly files: BundleFile[];
    readonly clips: number;
    readonly clipsComing: number;
    readonly filename: string;
  }> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: runId, workspaceId },
      select: {
        id: true,
        sourceTitle: true,
        sourceProjectId: true,
        sourceProject: { select: { title: true } },
      },
    });
    if (run === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
    const title =
      cleanSourceTitle(run.sourceTitle) ?? cleanSourceTitle(run.sourceProject.title) ?? "Clips";

    const picked = clipIds === undefined ? null : new Set(clipIds);
    const clips = (await runClipsOf(this.prisma, { workspaceId, runId })).filter(
      (clip) => picked === null || picked.has(clip.id),
    );
    const ids = clips.map((clip) => clip.id);
    const [captioned, clean, dubs, episode, compilations] = await Promise.all([
      reviewVideosOf(this.prisma, ids),
      cleanCutsOf(this.prisma, ids),
      dubFilesOf(this.prisma, { workspaceId, runId }, ids),
      picked === null ? episodePackOf(this.prisma, workspaceId, run.sourceProjectId) : null,
      picked === null ? this.compilationsOf(workspaceId, runId) : [],
    ]);
    const plans = clips.map((clip) =>
      planGuestClip({
        id: clip.id,
        title: clip.title,
        copy: clip.copy,
        images: clip.images,
        durationMs: clip.mezzanineDurationMs,
        captioned: captioned.get(clip.id) ?? new Map(),
        clean: clean.get(clip.id) ?? new Map(),
        // The team's own download: every finished file, approved or not.
        approval: NOT_REQUIRED,
        dubs: dubs.get(clip.id) ?? [],
      }),
    );
    const ready = plans.filter((plan) => plan !== null);
    const files = bundleFilesOf({
      runTitle: title,
      clips: ready.map((plan) => ({ plan })),
      compilations,
      episode,
      includeClean,
    });
    return {
      files,
      clips: ready.length,
      clipsComing: plans.length - ready.length,
      filename:
        picked === null
          ? `${safeSegment(title, 80, "Clips")}.zip`
          : `${safeSegment(title, 66, "Clips")} (${String(ready.length)} ${ready.length === 1 ? "clip" : "clips"}).zip`,
    };
  }

  /** The run's finished compilations whose file is still stored. */
  private async compilationsOf(workspaceId: string, runId: string): Promise<BundleCompilation[]> {
    const rows = await this.prisma.repurposeCompilation.findMany({
      where: { runId, workspaceId, status: "ready", exportId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { title: true, aspect: true, export: { select: { storageKey: true, status: true } } },
    });
    return rows.flatMap((row) =>
      row.export === null || row.export.status !== "succeeded" || row.export.storageKey === null
        ? []
        : [{ title: row.title, shape: SHAPE_OF_ASPECT[row.aspect], key: row.export.storageKey }],
    );
  }

  /**
   * Each file with its size: text measured, objects `HEAD`ed. An object gone
   * from the store, or one outside the workspace, is left out.
   */
  private async sized(workspaceId: string, files: readonly BundleFile[]): Promise<SizedFile[]> {
    const at = new Date(this.now());
    const results = new Map<number, SizedFile>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const file = files.at(index);
        if (file === undefined) return;
        if (file.source.kind === "text") {
          results.set(index, {
            file,
            size: Buffer.byteLength(file.source.text, "utf8"),
            modified: at,
          });
          continue;
        }
        if (!keyBelongsToWorkspace(file.source.key, workspaceId)) {
          this.logger.warn({ workspaceId }, "a run download refused a key outside its workspace");
          continue;
        }
        const head = await this.derived.head(file.source.key).catch(() => null);
        if (head === null) continue;
        results.set(index, { file, size: head.sizeBytes, modified: head.lastModified ?? at });
      }
    };
    await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, () => worker()));
    return [...results.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  }

  private async read(file: BundleFile): Promise<AsyncIterable<Uint8Array>> {
    if (file.source.kind === "text") return once(Buffer.from(file.source.text, "utf8"));
    if (this.derived.openRead === undefined) {
      throw new Error("this store cannot stream objects");
    }
    const { body } = await this.derived.openRead(file.source.key);
    return chunksOf(body);
  }
}

async function* once(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

function layoutBytes(files: readonly SizedFile[]): number {
  return zipLayout(files.map(({ file, size, modified }) => ({ name: file.path, size, modified })))
    .totalBytes;
}

function tokenKey(token: string): string {
  return `${redisKeyPrefix()}:repurpose:download:v1:${createHash("sha256").update(token).digest("hex")}`;
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
