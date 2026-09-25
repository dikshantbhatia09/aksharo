import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import { probeJobPayload } from "./probe-restart.js";
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
import type { Job, MediaAsset, Project } from "@prisma/client";

/**
 * The project fields an external acquisition needs: enough to build the key,
 * apply retention and take the project out of `draft`.
 *
 * Structural rather than `Project`, because the two callers hold different
 * things — the run producer has the `ProjectView` it just created, the completion
 * handler has the row it joined — and neither should re-read a project to name
 * three columns.
 */
export interface AcquisitionProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
}

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
  /**
   * Always `null` from here.
   *
   * The proxy is enqueued by the probe's completion handler as a child job, not
   * by this call (A07) — so at the moment `complete` answers there is no proxy
   * job to name. The field stays in the response because a client polls it and a
   * removed field is a breaking change; a client that wants the proxy watches the
   * media asset's derived keys instead.
   */
  readonly proxyJobId: string | null;
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

/** `apps/api/fixtures/sample-project/welcome.wav` — three seconds, ~48 KB. */
const SAMPLE_CLIP_FILENAME = "welcome.wav";
const SAMPLE_CLIP_MIME = "audio/wav";
let sampleClipCache: Buffer | undefined;

/**
 * The bundled sample clip's bytes, read once and cached.
 *
 * `resolve(__dirname, "..", "..", "fixtures", ...)` reaches the same file
 * whether this runs from `src/media/` (vitest, `nest start --watch`) or from
 * the compiled `dist/media/` (`nest build` sets `rootDir: ./src`, so `dist/`
 * mirrors `src/` with no extra segment) — both are two levels below `apps/api`.
 */
function loadSampleClip(): Buffer {
  sampleClipCache ??= readFileSync(
    resolve(__dirname, "..", "..", "fixtures", "sample-project", SAMPLE_CLIP_FILENAME),
  );
  return sampleClipCache;
}

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
 *   purge dates) -> enqueue media.probe
 * ```
 *
 * The object is finished before the row says so, and the row is written before
 * anything is enqueued, so a worker can never pick up a job for an object that is
 * not there. `JobsService.enqueue` dedupes on `jobKey`, so a client that retries
 * `complete` gets the same job id rather than two jobs. `media.proxy` follows as a
 * child of the probe's completion, not from here (A07).
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

  /**
   * Ingest the bundled sample clip into a freshly created project.
   *
   * `SampleProjectController` (A14) creates the project row through
   * `ProjectsService` and then calls this. The clip is a few tens of kilobytes,
   * and the caller is this process rather than a browser, so
   * `ObjectStore.put` — already used for the imported-subtitle sidecar — is the
   * right tool: there is no reason to open a multipart upload with one part.
   *
   * From here the sequence is `complete()`'s tail, unchanged: a `media_assets`
   * row, the plan's purge dates, the project's retention pushed out, and
   * `media.probe` enqueued. A sample behaves exactly like any other upload to
   * everything downstream of this call — including a worker that is not
   * running, in which case it simply sits at `uploaded` like any upload would.
   */
  async attachSample(workspaceId: string, project: Project): Promise<CompletedUpload> {
    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    const bytes = loadSampleClip();
    const mediaId = ulid();
    const key = rawKey(workspaceId, project.id, mediaId, "wav");

    await this.raw.put({ key, body: bytes, contentType: SAMPLE_CLIP_MIME, tags: RAW_OBJECT_TAGS });

    const uploadedAt = new Date();
    const created = await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId: project.id,
        role: "primary",
        bucket: this.raw.kind,
        storageKey: key,
        filename: SAMPLE_CLIP_FILENAME,
        mime: SAMPLE_CLIP_MIME,
        sizeBytes: BigInt(bytes.length),
        status: "uploaded",
        uploadedAt,
        rawPurgeAt: rawPurgeAt(uploadedAt),
        derivedPurgeAt: derivedPurgeAt(uploadedAt, limits),
      },
    });

    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        lastActivityAt: uploadedAt,
        retentionUntil: derivedPurgeAt(uploadedAt, limits),
        status: "active",
      },
    });

    await this.raw.tag(key, RAW_OBJECT_TAGS).catch((error: unknown) => {
      this.logger.debug({ key, err: describe(error) }, "raw tagging skipped");
    });

    return this.startPipeline(created, project, toMediaView(created));
  }

  // -------------------------------------------------------------------------
  // External acquisition (`media.acquire`)
  // -------------------------------------------------------------------------

  /**
   * Reserve the row and the object key an external acquisition will write into.
   *
   * There is no multipart ticket here and no client-declared size, because no
   * browser is involved: `media.acquire` fetches the bytes and `putFile`s them.
   * What this owns is the one thing a worker must never own — **the key**. It is
   * built by `rawKey` out of ids this process generated, so a remote title with
   * `../` in it is just a title (master plan §8.2, THREAT-MODEL T5).
   *
   * The row starts `pending`, which is what an upload that has not finished looks
   * like too. That is deliberate: the run's stage derivation reads the media row,
   * so "we are still getting your video" needs no second source of truth.
   */
  async reserveAcquisition(
    project: AcquisitionProject,
    input: { readonly filename: string; readonly mime: string },
  ): Promise<{ readonly media: MediaAsset; readonly bucket: "s3" | "r2"; readonly key: string }> {
    const mediaId = ulid();
    const key = rawKey(
      project.workspaceId,
      project.id,
      mediaId,
      extensionFor(input.filename, input.mime),
    );
    const media = await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId: project.id,
        role: "primary",
        bucket: this.raw.kind,
        storageKey: key,
        filename: input.filename,
        mime: input.mime,
        status: "pending",
      },
    });
    return { media, bucket: this.raw.kind, key };
  }

  /**
   * {@link complete}'s tail, for bytes a worker wrote rather than a browser:
   * `media.acquire` (a fetched source) and `media.clip` (a repurposed clip's
   * mezzanine).
   *
   * Identical in effect to finishing an upload — the store's own size, the plan's
   * purge dates, the project's retention pushed out, `media.probe` enqueued — and
   * deliberately so: past this point an acquired video must be indistinguishable
   * from an uploaded one, or every downstream stage needs two code paths.
   *
   * Two differences, both from who is calling:
   *
   *   * **A missing object throws.** A `complete` call that cannot find its
   *     object means a broken client; a *worker* reporting success for an object
   *     the store does not have means the callback and the upload disagree, and
   *     the honest answer is 5xx so the attempt is retried rather than a probe
   *     enqueued against nothing.
   *   * **The probe is a child job with `skipAdmission`.** The workspace was
   *     admitted once, when the run was created. Making the second half of that
   *     same work queue for its own slot is how a Free workspace 429s itself
   *     halfway through its own video — the same reasoning `media.probe` uses
   *     when it enqueues `media.proxy`.
   *
   * Idempotent: the writes are plain overwrites of measured facts and
   * `enqueueChild` dedupes on `media.probe:{mediaId}`, so a replayed callback
   * produces the same row and the same job id.
   */
  async completeAcquisition(input: {
    readonly media: MediaAsset;
    readonly project: AcquisitionProject;
    readonly parent: Job;
    readonly sizeBytes: number;
    readonly mime: string;
    readonly contentHash: string;
  }): Promise<{ readonly media: MediaAsset; readonly probeJobId: string }> {
    const head = await this.raw.head(input.media.storageKey);
    if (head === null) {
      throw new Error(
        `a worker reported ${input.media.storageKey}, which the raw store does not have`,
      );
    }

    if (head.sizeBytes !== input.sizeBytes) {
      // Not fatal — the store is the authority either way — but the two numbers
      // disagreeing means the upload and the measurement saw different files.
      this.logger.warn(
        { mediaId: input.media.id, stored: head.sizeBytes, reported: input.sizeBytes },
        "a worker reported a size the raw store does not agree with",
      );
    }

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(input.project.workspaceId));
    const uploadedAt = new Date();
    const updated = await this.prisma.mediaAsset.update({
      where: { id: input.media.id },
      data: {
        status: "uploaded",
        uploadedAt,
        sizeBytes: BigInt(head.sizeBytes),
        contentHash: input.contentHash,
        mime: head.contentType ?? input.mime,
        rawPurgeAt: rawPurgeAt(uploadedAt),
        derivedPurgeAt: derivedPurgeAt(uploadedAt, limits),
      },
    });

    await this.prisma.project.update({
      where: { id: input.project.id },
      data: {
        lastActivityAt: uploadedAt,
        retentionUntil: derivedPurgeAt(uploadedAt, limits),
        ...(input.project.status === "draft" ? { status: "active" as const } : {}),
      },
    });

    await this.raw.tag(updated.storageKey, RAW_OBJECT_TAGS).catch((error: unknown) => {
      this.logger.debug({ key: updated.storageKey, err: describe(error) }, "raw tagging skipped");
    });

    const probe = await this.jobs.enqueueChild(input.parent, {
      type: "media.probe",
      payload: this.probePayload(updated, input.project),
      worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
      jobKey: MEDIA_JOB_KEYS.probe(updated.id),
      reason: `media.probe · ${updated.id}`,
      skipAdmission: true,
    });

    return { media: updated, probeJobId: probe.job.id };
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
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
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
   * Enqueue `media.probe`, and only `media.probe` (CONTRACTS §3).
   *
   * A06 enqueued the proxy here too, which took **two** admission slots for one
   * upload: a Free workspace has a lane of two, so its second concurrent upload
   * 429'd on `jobs/concurrency_cap` with nothing wrong anywhere. The proxy is the
   * second half of one piece of work and now rides on the probe's completion as a
   * child job (`MediaProbeCompletionHandler`), which also means it is never built
   * for a file the probe rejected.
   *
   * The job costs no credits: `04-pricing` charges for transcription, translation,
   * passes and cloud renders, and normalising an upload is not one of them.
   */
  private async startPipeline(
    media: MediaAsset,
    project: Project,
    view: MediaView,
  ): Promise<CompletedUpload> {
    const probe = await this.jobs.enqueue({
      type: "media.probe",
      workspaceId: project.workspaceId,
      projectId: project.id,
      params: this.probePayload(media, project),
      jobKey: MEDIA_JOB_KEYS.probe(media.id),
      worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
      reason: `media.probe · ${media.id}`,
    });

    return { media: view, probeJobId: probe.job.id, proxyJobId: null };
  }

  /** What `media.probe` is told about an asset (`probeJobPayload`, shared with `MediaProbeRestart`). */
  private probePayload(media: MediaAsset, project: AcquisitionProject): Record<string, unknown> {
    return probeJobPayload(media, project.id, { raw: this.raw.kind, derived: this.derived.kind });
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
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
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
