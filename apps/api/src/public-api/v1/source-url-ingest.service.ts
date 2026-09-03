import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { AppException, PrismaService, RAW_STORE } from "../../common/index.js";
import { safeFetch, SafeFetchError } from "../../common/net/index.js";
import { rawKey } from "../../common/storage/index.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "../../media/media.constants.js";
import { derivedPurgeAt, mediaLimitsFor, rawPurgeAt } from "../../projects/plan-limits.js";
import { RAW_OBJECT_TAGS } from "../../projects/projects.constants.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import {
  PUBLIC_API_ERRORS,
  SOURCE_URL_ALLOWED_CONTENT_TYPES,
  SOURCE_URL_FETCH_TIMEOUT_MS,
  SOURCE_URL_MAX_REDIRECTS,
} from "../public-api.constants.js";

import type { ObjectStore } from "../../common/storage/index.js";
import type { Project } from "@prisma/client";

/**
 * `sourceUrl` project creation (B14 §1/§3): fetch the caller's URL under the
 * SSRF guard, store it as this project's primary media, start the same
 * `media.probe` pipeline an uploaded file gets.
 *
 * `MediaService` (A06) has no public method for this shape — its surface is
 * built for a browser doing a presigned multipart PUT (`init`/`complete`) or,
 * for a small in-process buffer, `attachSample()`. This is the same shape as
 * `attachSample()` (buffer already in hand → one `ObjectStore.put` → a
 * `media_assets` row → `media.probe`), built from the same exported primitives
 * (`RAW_STORE`, `rawKey`, `MEDIA_JOB_KEYS`) rather than by adding a method to
 * `media/media.service.ts`, which is outside this WP's file boundaries — the
 * missing seam is `MediaService` having no public "ingest a buffer this
 * process already downloaded" entry point; this is that entry point, scoped to
 * `public-api/` until `media/`'s owner decides whether to fold it in.
 *
 * SSRF guard (brief §3, all delegated to `common/net/safe-fetch.ts`, A06):
 * https only, DNS resolved and every address judged against the private/
 * loopback/link-local/metadata deny list, the connection pinned to the vetted
 * address, redirects re-validated the same way and capped at
 * {@link SOURCE_URL_MAX_REDIRECTS}, body capped by the plan's `maxFileBytes`,
 * a hard timeout, and only an allow-listed set of media content types.
 */
@Injectable()
export class SourceUrlIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
  ) {}

  async ingest(
    workspaceId: string,
    project: Project,
    sourceUrl: string,
  ): Promise<{ readonly mediaId: string; readonly probeJobId: string }> {
    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));

    let downloaded;
    try {
      downloaded = await safeFetch(sourceUrl, {
        maxBytes: limits.maxFileBytes,
        timeoutMs: SOURCE_URL_FETCH_TIMEOUT_MS,
        maxRedirects: SOURCE_URL_MAX_REDIRECTS,
        allowedPorts: [443],
      });
    } catch (error) {
      throw sourceUrlError(error);
    }

    if (downloaded.status < 200 || downloaded.status >= 300) {
      throw new AppException(
        PUBLIC_API_ERRORS.sourceUrlRejected,
        `sourceUrl answered HTTP ${String(downloaded.status)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const contentType = (downloaded.contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType === undefined || !SOURCE_URL_ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new AppException(
        PUBLIC_API_ERRORS.sourceUrlRejected,
        `sourceUrl's content-type (${contentType ?? "unknown"}) is not a supported media type.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const mediaId = ulid();
    const extension = extensionForContentType(contentType);
    const key = rawKey(workspaceId, project.id, mediaId, extension);
    await this.raw.put({
      key,
      body: downloaded.body,
      contentType,
      tags: RAW_OBJECT_TAGS,
    });

    const uploadedAt = new Date();
    const filename = filenameFrom(sourceUrl, extension);
    const media = await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId: project.id,
        role: "primary",
        bucket: this.raw.kind,
        storageKey: key,
        filename,
        mime: contentType,
        sizeBytes: BigInt(downloaded.body.byteLength),
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

    await this.raw.tag(key, RAW_OBJECT_TAGS).catch(() => undefined);

    const probe = await this.jobs.enqueue({
      type: "media.probe",
      workspaceId,
      projectId: project.id,
      params: {
        mediaId: media.id,
        projectId: project.id,
        bucket: this.raw.kind,
        key: media.storageKey,
        mime: media.mime,
        sizeBytes: Number(media.sizeBytes ?? 0),
        derivedBucket: this.raw.kind,
        derivedPrefix: media.storageKey.slice(0, media.storageKey.lastIndexOf("/")),
      },
      jobKey: MEDIA_JOB_KEYS.probe(media.id),
      worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
      reason: `media.probe · ${media.id} (public API sourceUrl)`,
    });

    return { mediaId: media.id, probeJobId: probe.job.id };
  }
}

function sourceUrlError(error: unknown): AppException {
  if (error instanceof SafeFetchError) {
    const status =
      error.code === "too_large" ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.UNPROCESSABLE_ENTITY;
    return new AppException(PUBLIC_API_ERRORS.sourceUrlRejected, error.message, status, {
      reason: error.code,
    });
  }
  return new AppException(
    PUBLIC_API_ERRORS.sourceUrlRejected,
    "sourceUrl could not be fetched.",
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

function extensionForContentType(contentType: string): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";
}

function filenameFrom(sourceUrl: string, fallbackExtension: string): string {
  try {
    const url = new URL(sourceUrl);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (last !== undefined && last.includes(".")) return last;
  } catch {
    // fall through
  }
  return `source.${fallbackExtension}`;
}
