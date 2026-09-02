import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import {
  DERIVED_STORE,
  DOWNLOAD_URL_TTL_SECONDS,
  extensionOf,
  normaliseExtension,
  RAW_STORE,
  rawKey,
} from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { derivedPurgeAt, mediaLimitsFor, rawPurgeAt } from "../projects/plan-limits.js";
import {
  ALLOWED_MEDIA_EXTENSIONS,
  ALLOWED_MEDIA_MIME_TYPES,
  MEDIA_ERRORS,
  MIME_FALLBACK_EXTENSIONS,
  RAW_OBJECT_TAGS,
} from "../projects/projects.constants.js";
import { ProjectsService } from "../projects/projects.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { CompletedPart, ObjectStore } from "../common/storage/index.js";
import type { PlanMediaLimits } from "../projects/plan-limits.js";
import type { MediaAsset, Project } from "@prisma/client";

export interface DerivedKeysView {
  readonly proxy: string | null;
  readonly audio16k: string | null;
  readonly audio48k: string | null;
  readonly waveform: string | null;
  readonly thumbs: readonly string[];
}

export interface MediaView {
  readonly id: string;
  readonly projectId: string;
  readonly role: string;
  readonly bucket: "s3" | "r2";
  readonly storageKey: string;
  readonly filename: string | null;
  readonly mime: string | null;
  readonly sizeBytes: number | null;
  readonly contentHash: string | null;
  readonly durationMs: number | null;
  readonly fps: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly audioChannels: number | null;
  readonly status: string;
  readonly needsRealign: boolean;
  readonly uploadedAt: string | null;
  readonly rawPurgeAt: string | null;
  readonly derivedPurgeAt: string | null;
  readonly derived: DerivedKeysView;
  readonly createdAt: string;
}

export interface UploadTicket {
  readonly mediaId: string;
  readonly uploadId: string | null;
  readonly key: string;
  readonly bucket: "s3" | "r2";
  readonly partSizeBytes: number;
  readonly parts: readonly { readonly partNumber: number; readonly url: string }[];
  readonly expiresAt: string | null;
  readonly duplicate: boolean;
  readonly media: MediaView;
}

export interface InitUploadInput {
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly contentHash?: string;
  readonly role?: "primary" | "broll" | "audio";
}

export interface CompletedUpload {
  readonly media: MediaView;
  readonly probeJobId: string;
  readonly proxyJobId: string;
}

export interface MediaUrls {
  readonly mediaId: string;
  readonly proxy?: string;
  readonly audio16k?: string;
  readonly audio48k?: string;
  readonly waveform?: string;
  readonly thumbs: readonly string[];
  readonly expiresAt: string;
}

/** Media states in which the bytes are known to be present and complete. */
const SETTLED_STATUSES: readonly string[] = ["uploaded", "probing", "ready"];

/**
 * Media ingest: presigned multipart upload, completion, derived URLs, replace.
 *
 * **The bytes never touch this process.** `init` signs a multipart upload
 * straight against the raw bucket and hands the URLs to the browser; `complete`
 * closes the upload and asks the store how big the object actually is. An API
 * that proxied uploads would hold a Node process for the length of a 2 GB
 * transfer and would put the residency boundary (THREAT-MODEL T24) in the wrong
 * place.
 *
 * The order inside {@link complete} is the design:
 *
 * ```
 * complete the multipart upload -> HEAD for the real size -> row (uploadedAt,
 *   purge dates) -> enqueue media.probe -> enqueue media.proxy
 * ```
 *
 * The object is finished before the row says so, and the row is written before
 * anything is enqueued, so a worker can never pick up a job for an object that is
 * not there. `JobsService.enqueue` dedupes on `jobKey`, so a client that retries
 * `complete` gets the same two job ids rather than four jobs.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly entitlements: EntitlementService,
    private readonly jobs: JobsService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(workspaceId: string, projectId: string): Promise<MediaView[]> {
    await this.projects.requireProject(workspaceId, projectId);
    const rows = await this.prisma.mediaAsset.findMany({
      where: { projectId },
      orderBy: { id: "asc" },
    });
    return rows.map(toMediaView);
  }

  /**
   * One media asset, with the project it belongs to.
   *
   * The workspace is joined in rather than compared afterwards, so a media id
   * from another tenant matches nothing and answers 404 (THREAT-MODEL T5). This
   * is the only lookup the media routes use, which is what keeps that property
   * from depending on a caller remembering to check.
   */
  async require(
    workspaceId: string,
    mediaId: string,
    projectId?: string,
  ): Promise<{ media: MediaAsset; project: Project }> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: {
        id: mediaId,
        ...(projectId === undefined ? {} : { projectId }),
        project: { workspaceId, deletedAt: null },
      },
      include: { project: true },
    });
    if (media === null) {
      throw new AppException(MEDIA_ERRORS.notFound, "No such media.", HttpStatus.NOT_FOUND, {
        mediaId,
      });
    }
    const { project, ...rest } = media;
    return { media: rest as MediaAsset, project };
  }

  async get(workspaceId: string, mediaId: string, projectId?: string): Promise<MediaView> {
    const { media } = await this.require(workspaceId, mediaId, projectId);
    return toMediaView(media);
  }

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------

  async initUpload(
    workspaceId: string,
    projectId: string,
    input: InitUploadInput,
  ): Promise<UploadTicket> {
    const project = await this.projects.requireProject(workspaceId, projectId);
    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));

    const mime = normaliseMime(input.mime);
    assertAllowedType(mime, input.filename);
    assertWithinPlan(input.size, limits);

    // Duplicate detection is per workspace, not per project: the same footage cut
    // into two projects should upload once. The existing row is returned with no
    // upload id at all, so a client that ignores `duplicate` simply has nothing to
    // PUT and calls `complete` on a media item that is already complete.
    if (input.contentHash !== undefined) {
      const existing = await this.findDuplicate(workspaceId, input.contentHash);
      if (existing !== null) {
        return {
          mediaId: existing.id,
          uploadId: null,
          key: existing.storageKey,
          bucket: existing.bucket,
          partSizeBytes: existing.partSizeBytes ?? 0,
          parts: [],
          expiresAt: null,
          duplicate: true,
          media: toMediaView(existing),
        };
      }
    }

    const mediaId = ulid();
    const key = rawKey(workspaceId, projectId, mediaId, extensionFor(input.filename, mime));

    const created = await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId: project.id,
        role: input.role ?? "primary",
        bucket: "s3",
        storageKey: key,
        filename: input.filename,
        mime,
        sizeBytes: BigInt(input.size),
        contentHash: input.contentHash ?? null,
        status: "pending",
      },
    });

    return this.signUpload(created, input.size, mime, key);
  }

  /**
   * `POST /projects/{id}/media/{mediaId}/replace`.
   *
   * The **same row** takes new bytes, which is the whole point: the project's
   * transcript, EDG document and exports all reference this media id, and
   * replacing the row would orphan every one of them. What does change is
   * `needs_realign`: the words are still right but their timings are not, and A11
   * reads that flag to decide whether to re-run `ai.align`.
   */
  async replace(
    workspaceId: string,
    projectId: string,
    mediaId: string,
    input: InitUploadInput,
  ): Promise<UploadTicket> {
    const { media, project } = await this.require(workspaceId, mediaId, projectId);
    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));

    const mime = normaliseMime(input.mime);
    assertAllowedType(mime, input.filename);
    assertWithinPlan(input.size, limits);

    // An upload the client abandoned still holds parts in the bucket and is
    // billable, so it goes before a second one is opened on the same row.
    if (media.uploadId !== null) {
      await this.raw.abortMultipartUpload(media.storageKey, media.uploadId);
    }

    const key = rawKey(workspaceId, project.id, media.id, extensionFor(input.filename, mime));
    const reset = await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        storageKey: key,
        filename: input.filename,
        mime,
        sizeBytes: BigInt(input.size),
        contentHash: input.contentHash ?? null,
        status: "pending",
        needsRealign: true,
        uploadedAt: null,
        uploadId: null,
        // Everything below described the *old* bytes. A07 rewrites them from the
        // new probe; leaving them would show a stale proxy next to new footage.
        durationMs: null,
        fps: null,
        width: null,
        height: null,
        audioChannels: null,
        proxyKey: null,
        audio16kKey: null,
        audio48kKey: null,
        waveformKey: null,
        thumbKeys: [],
        rawPurgedAt: null,
        derivedPurgedAt: null,
      },
    });

    return this.signUpload(reset, input.size, mime, key);
  }

  /**
   * `POST /media/{mediaId}/complete` — close the multipart upload and start the
   * pipeline.
   */
  async complete(
    workspaceId: string,
    mediaId: string,
    etags: readonly string[],
    projectId?: string,
  ): Promise<CompletedUpload> {
    const { media, project } = await this.require(workspaceId, mediaId, projectId);

    // Already complete: answer with the same two job ids rather than a 409. A
    // client that retries after a dropped response has done nothing wrong, and
    // `enqueue` dedupes on `jobKey` anyway.
    if (media.uploadId === null && SETTLED_STATUSES.includes(media.status)) {
      return this.startPipeline(media, project, toMediaView(media));
    }
    if (media.uploadId === null) {
      throw new AppException(
        MEDIA_ERRORS.invalidState,
        "This media has no upload in progress.",
        HttpStatus.CONFLICT,
        { mediaId, status: media.status },
      );
    }

    const parts: CompletedPart[] = etags.map((etag, index) => ({
      partNumber: index + 1,
      etag: etag.startsWith('"') ? etag : `"${etag}"`,
    }));

    try {
      await this.raw.completeMultipartUpload(media.storageKey, media.uploadId, parts);
    } catch (error) {
      throw new AppException(
        MEDIA_ERRORS.uploadFailed,
        "The upload could not be completed; check that every part was uploaded.",
        HttpStatus.CONFLICT,
        { mediaId, parts: parts.length, cause: describe(error) },
      );
    }

    // The store's own size, not the client's claim. Everything downstream — the
    // duration estimate, the egress accounting, the plan check on re-upload —
    // reads this column.
    const head = await this.raw.head(media.storageKey);
    const sizeBytes = head?.sizeBytes ?? Number(media.sizeBytes ?? 0);

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    if (sizeBytes > limits.maxFileBytes) {
      // The declared size passed the check and the real one did not, which means
      // the client under-declared. The object is removed rather than kept: it is
      // over the plan cap and nothing may read it.
      await this.raw.delete(media.storageKey).catch(() => undefined);
      await this.prisma.mediaAsset.update({
        where: { id: media.id },
        data: { status: "failed", uploadId: null },
      });
      throw tooLarge(sizeBytes, limits);
    }

    const uploadedAt = new Date();
    const updated = await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        status: "uploaded",
        uploadId: null,
        uploadedAt,
        sizeBytes: BigInt(sizeBytes),
        rawPurgeAt: rawPurgeAt(uploadedAt),
        derivedPurgeAt: derivedPurgeAt(uploadedAt, limits),
        ...(head?.contentType === undefined ? {} : { mime: head.contentType }),
      },
    });

    // Retention on the project moves with its newest upload (D47): a project
    // somebody is still adding footage to is not a project to expire.
    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        lastActivityAt: uploadedAt,
        retentionUntil: derivedPurgeAt(uploadedAt, limits),
        ...(project.status === "draft" ? { status: "active" as const } : {}),
      },
    });

    // Best effort: the lifecycle rule is a backstop to `purgeDueMedia()`, so a
    // store that does not do tagging must not fail an upload.
    await this.raw.tag(media.storageKey, RAW_OBJECT_TAGS).catch((error: unknown) => {
      this.logger.debug({ key: media.storageKey, err: describe(error) }, "raw tagging skipped");
    });

    return this.startPipeline(updated, project, toMediaView(updated));
  }

  // -------------------------------------------------------------------------
  // Derived URLs
  // -------------------------------------------------------------------------

  /**
   * Short-lived signed GETs for whatever the pipeline has produced so far.
   *
   * Only keys that exist are signed, so the response doubles as "what is ready";
   * the TTL is five minutes because these URLs end up in a browser's network log,
   * a bug report and occasionally a screenshot.
   */
  async urls(workspaceId: string, projectId: string, mediaId: string): Promise<MediaUrls> {
    const { media } = await this.require(workspaceId, mediaId, projectId);
    const ttl = DOWNLOAD_URL_TTL_SECONDS;

    const named: readonly [keyof MediaUrls, string | null][] = [
      ["proxy", media.proxyKey],
      ["audio16k", media.audio16kKey],
      ["audio48k", media.audio48kKey],
      ["waveform", media.waveformKey],
    ];

    const signed: Record<string, string> = {};
    for (const [name, key] of named) {
      if (key === null || key === "") continue;
      signed[name] = await this.derived.presignGet(key, ttl);
    }
    const thumbs: string[] = [];
    for (const key of media.thumbKeys) {
      if (key === "") continue;
      thumbs.push(await this.derived.presignGet(key, ttl));
    }

    return {
      mediaId: media.id,
      ...signed,
      thumbs,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Open a multipart upload against the raw store and record it on the row. */
  private async signUpload(
    media: MediaAsset,
    sizeBytes: number,
    mime: string,
    key: string,
  ): Promise<UploadTicket> {
    const upload = await this.raw.createMultipartUpload({
      key,
      sizeBytes,
      contentType: mime,
      tags: RAW_OBJECT_TAGS,
    });

    const updated = await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        status: "uploading",
        uploadId: upload.uploadId,
        partSizeBytes: upload.partSizeBytes,
      },
    });

    return {
      mediaId: media.id,
      uploadId: upload.uploadId,
      key,
      bucket: this.raw.kind,
      partSizeBytes: upload.partSizeBytes,
      parts: upload.parts,
      expiresAt: upload.expiresAt,
      duplicate: false,
      media: toMediaView(updated),
    };
  }

  /**
   * Enqueue `media.probe` and then `media.proxy` (CONTRACTS §3).
   *
   * Both are enqueued here rather than the probe enqueuing the proxy as a child,
   * because the brief says the API is the producer for both and because a
   * workspace's admission decision should be taken once, at upload, rather than
   * inside a worker. Neither job costs credits: `04-pricing` charges for
   * transcription, translation, passes and cloud renders, and normalising an
   * upload is not one of them.
   */
  private async startPipeline(
    media: MediaAsset,
    project: Project,
    view: MediaView,
  ): Promise<CompletedUpload> {
    const payload = {
      mediaId: media.id,
      projectId: project.id,
      bucket: this.raw.kind,
      key: media.storageKey,
      mime: media.mime,
      sizeBytes: Number(media.sizeBytes ?? 0),
      derivedBucket: this.derived.kind,
      derivedPrefix: media.storageKey.slice(0, media.storageKey.lastIndexOf("/")),
    };

    const probe = await this.jobs.enqueue({
      type: "media.probe",
      workspaceId: project.workspaceId,
      projectId: project.id,
      params: payload,
      jobKey: MEDIA_JOB_KEYS.probe(media.id),
      worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
      reason: `media.probe · ${media.id}`,
    });

    const proxy = await this.jobs.enqueue({
      type: "media.proxy",
      workspaceId: project.workspaceId,
      projectId: project.id,
      params: payload,
      jobKey: MEDIA_JOB_KEYS.proxy(media.id),
      worstCaseTenths: MEDIA_JOB_QUOTES.proxyTenths,
      reason: `media.proxy · ${media.id}`,
    });

    return { media: view, probeJobId: probe.job.id, proxyJobId: proxy.job.id };
  }

  /** A settled upload of the same bytes, anywhere in this workspace. */
  private async findDuplicate(
    workspaceId: string,
    contentHash: string,
  ): Promise<MediaAsset | null> {
    return this.prisma.mediaAsset.findFirst({
      where: {
        contentHash,
        status: { in: ["uploaded", "probing", "ready"] },
        rawPurgedAt: null,
        project: { workspaceId, deletedAt: null },
      },
      orderBy: { id: "desc" },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toMediaView(media: MediaAsset): MediaView {
  return {
    id: media.id,
    projectId: media.projectId,
    role: media.role,
    bucket: media.bucket,
    storageKey: media.storageKey,
    filename: media.filename,
    mime: media.mime,
    sizeBytes: media.sizeBytes === null ? null : Number(media.sizeBytes),
    contentHash: media.contentHash,
    durationMs: media.durationMs,
    fps: media.fps,
    width: media.width,
    height: media.height,
    audioChannels: media.audioChannels,
    status: media.status,
    needsRealign: media.needsRealign,
    uploadedAt: media.uploadedAt?.toISOString() ?? null,
    rawPurgeAt: media.rawPurgeAt?.toISOString() ?? null,
    derivedPurgeAt: media.derivedPurgeAt?.toISOString() ?? null,
    derived: {
      proxy: media.proxyKey,
      audio16k: media.audio16kKey,
      audio48k: media.audio48kKey,
      waveform: media.waveformKey,
      thumbs: media.thumbKeys,
    },
    createdAt: media.createdAt.toISOString(),
  };
}

/** Lowercase, parameters (`; codecs=...`) dropped. */
export function normaliseMime(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The extension a raw key gets.
 *
 * The filename is only a hint, and a hostile one at that: it is taken only when
 * it is on the allow-list, and otherwise the declared (and already allow-listed)
 * media type decides. That way no attacker-controlled string ever reaches a key
 * — `storage.keys.ts` would refuse anything odd, but the belt is cheaper than the
 * exception.
 */
export function extensionFor(filename: string, mime: string): string {
  const fromName = extensionOf(filename);
  if (fromName !== undefined && ALLOWED_MEDIA_EXTENSIONS.includes(fromName)) return fromName;
  const fromMime = MIME_FALLBACK_EXTENSIONS[mime];
  if (fromMime !== undefined) return fromMime;
  return normaliseExtension("bin");
}

/** @throws AppException 415 when the declared type is not one we accept (T7). */
export function assertAllowedType(mime: string, filename: string): void {
  const extension = extensionOf(filename);
  const knownExtension = extension !== undefined && ALLOWED_MEDIA_EXTENSIONS.includes(extension);
  if (ALLOWED_MEDIA_MIME_TYPES.includes(mime)) return;

  // A generic `application/octet-stream` from a browser that could not guess is
  // accepted when the extension is one we know; anything else is refused.
  if ((mime === "application/octet-stream" || mime === "") && knownExtension) return;

  throw new AppException(
    MEDIA_ERRORS.unsupportedType,
    "That file type cannot be uploaded.",
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    { mime, allowed: ALLOWED_MEDIA_MIME_TYPES },
  );
}

/** @throws AppException 413 `media/too_large` when the plan does not allow it. */
export function assertWithinPlan(sizeBytes: number, limits: PlanMediaLimits): void {
  if (sizeBytes <= limits.maxFileBytes) return;
  throw tooLarge(sizeBytes, limits);
}

function tooLarge(sizeBytes: number, limits: PlanMediaLimits): AppException {
  return new AppException(
    ERROR_CODES.mediaTooLarge,
    `The ${limits.planKey} plan allows files up to ${String(
      Math.floor(limits.maxFileBytes / (1024 * 1024)),
    )} MB.`,
    HttpStatus.PAYLOAD_TOO_LARGE,
    { sizeBytes, maxFileBytes: limits.maxFileBytes, plan: limits.planKey },
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
