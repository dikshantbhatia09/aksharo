import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { isSubtitleKind, parseSubtitles, SubtitleParseError } from "./subtitle-parsers.js";
import { AppException, PrismaService } from "../../common/index.js";
import { SafeFetchError, safeFetch } from "../../common/net/index.js";
import { DERIVED_STORE, subtitleKey } from "../../common/storage/index.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { derivedPurgeAt, mediaLimitsFor } from "../../projects/plan-limits.js";
import {
  DERIVED_OBJECT_TAGS,
  IMPORT_ERRORS,
  IMPORT_FETCH_TIMEOUT_MS,
  IMPORT_MAX_BYTES,
} from "../../projects/projects.constants.js";
import { ProjectsService } from "../../projects/projects.service.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "../media.constants.js";

import type { SubtitleKind } from "./subtitle-parsers.js";
import type { ObjectStore } from "../../common/storage/index.js";

export interface ImportSubtitlesInput {
  readonly kind: SubtitleKind;
  readonly content: string;
  readonly language?: string;
  /** Align against this media item rather than the project's primary one. */
  readonly mediaId?: string;
}

export interface ImportUrlInput {
  readonly url: string;
  readonly kind?: SubtitleKind;
  readonly language?: string;
  readonly mediaId?: string;
}

export interface ImportResult {
  readonly mediaId: string;
  readonly kind: SubtitleKind;
  readonly key: string;
  readonly cueCount: number;
  readonly timed: boolean;
  readonly warnings: readonly string[];
  readonly jobId: string;
}

/** Version stamp on the stored sidecar, so a later reader knows the shape. */
export const SUBTITLE_SIDECAR_VERSION = 1;

/**
 * `POST /projects/{id}/import` and `/import-url`.
 *
 * An existing subtitle file is a *transcript somebody already paid for*: the
 * words are right, and only the timings need work. So the import path parses the
 * file into one normalised cue list, stores it as a JSON sidecar in the derived
 * bucket under the media prefix, and enqueues `ai.align` — it does not create a
 * transcript, because transcripts are A11's and inventing half of one here would
 * be a second implementation for A11 to delete.
 *
 * The sidecar is a `media_assets` row with role `subtitle`, which means the
 * retention sweep, the purge dates and the project cascade all cover it with no
 * special case anywhere.
 */
@Injectable()
export class SubtitleImportService {
  private readonly logger = new Logger(SubtitleImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly entitlements: EntitlementService,
    private readonly jobs: JobsService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  async importInline(
    workspaceId: string,
    projectId: string,
    input: ImportSubtitlesInput,
  ): Promise<ImportResult> {
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > IMPORT_MAX_BYTES) {
      throw new AppException(
        IMPORT_ERRORS.tooLarge,
        `A subtitle import may be at most ${String(IMPORT_MAX_BYTES / (1024 * 1024))} MB.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { bytes, maxBytes: IMPORT_MAX_BYTES },
      );
    }
    return this.store(workspaceId, projectId, input.kind, input.content, input, null);
  }

  /**
   * Import from a URL the caller supplied (THREAT-MODEL **T6**).
   *
   * Every rule lives in `safeFetch`; this method's only job is to turn its
   * refusals into API error codes, which it does by *code* rather than by
   * message, so nothing about the internal network reaches the client.
   */
  async importFromUrl(
    workspaceId: string,
    projectId: string,
    input: ImportUrlInput,
  ): Promise<ImportResult> {
    const kind = input.kind ?? kindFromUrl(input.url);
    if (kind === undefined) {
      throw new AppException(
        IMPORT_ERRORS.unsupportedKind,
        "Say which subtitle format that URL holds.",
        HttpStatus.BAD_REQUEST,
        { url: input.url },
      );
    }

    let body: Buffer;
    try {
      const fetched = await safeFetch(input.url, {
        maxBytes: IMPORT_MAX_BYTES,
        timeoutMs: IMPORT_FETCH_TIMEOUT_MS,
      });
      if (fetched.status < 200 || fetched.status >= 300) {
        throw new AppException(
          IMPORT_ERRORS.fetchFailed,
          "That URL did not return a file.",
          HttpStatus.BAD_GATEWAY,
          { status: fetched.status },
        );
      }
      body = fetched.body;
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw importFetchError(error);
    }

    return this.store(workspaceId, projectId, kind, body.toString("utf8"), input, input.url);
  }

  private async store(
    workspaceId: string,
    projectId: string,
    kind: SubtitleKind,
    content: string,
    input: { readonly language?: string; readonly mediaId?: string },
    sourceUrl: string | null,
  ): Promise<ImportResult> {
    const project = await this.projects.requireProject(workspaceId, projectId);

    let parsed;
    try {
      parsed = parseSubtitles(kind, content);
    } catch (error) {
      throw new AppException(
        IMPORT_ERRORS.unparsable,
        error instanceof SubtitleParseError
          ? `That file could not be read as ${kind.toUpperCase()}: ${error.message}.`
          : `That file could not be read as ${kind.toUpperCase()}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { kind },
      );
    }

    // Naming the media it belongs to is optional; when it is given it must be in
    // this project, which `MediaService.require` would also enforce — done here
    // with one query rather than by injecting the whole service and creating a
    // cycle between the two.
    if (input.mediaId !== undefined) {
      const target = await this.prisma.mediaAsset.count({
        where: { id: input.mediaId, projectId: project.id },
      });
      if (target === 0) {
        throw new AppException(
          IMPORT_ERRORS.unsupportedKind,
          "No such media in this project.",
          HttpStatus.NOT_FOUND,
          { mediaId: input.mediaId },
        );
      }
    }

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    const mediaId = ulid();
    const key = subtitleKey(workspaceId, project.id, mediaId);
    const now = new Date();

    const document = {
      version: SUBTITLE_SIDECAR_VERSION,
      kind: parsed.kind,
      timed: parsed.timed,
      language: input.language ?? project.sourceLanguage ?? null,
      alignsMediaId: input.mediaId ?? null,
      sourceUrl,
      importedAt: now.toISOString(),
      cues: parsed.cues,
    };
    const body = JSON.stringify(document);

    await this.derived.put({
      key,
      body,
      contentType: "application/json; charset=utf-8",
      tags: DERIVED_OBJECT_TAGS,
    });

    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId: project.id,
        role: "subtitle",
        bucket: this.derived.kind,
        storageKey: key,
        filename: sourceUrl === null ? `import.${parsed.kind}` : filenameFromUrl(sourceUrl),
        mime: "application/json",
        sizeBytes: BigInt(Buffer.byteLength(body, "utf8")),
        status: "ready",
        uploadedAt: now,
        // No raw object exists for an import, so there is nothing to purge at
        // seven days; the sidecar lives exactly as long as the derived artefacts.
        derivedPurgeAt: derivedPurgeAt(now, limits),
      },
    });

    await this.projects.touch(project.id, now);

    const alignTarget = input.mediaId ?? (await this.primaryMediaId(project.id));
    const transcriptId = ulid();
    const job = await this.jobs.enqueue({
      type: "ai.align",
      workspaceId,
      projectId: project.id,
      params: {
        // B15 §6: the worker's own contract (`ai.align`) needs
        // `segments: [{startMs, endMs, text}]` built from the cues, not a
        // reference to the sidecar it cannot read on its own.
        mode: "import",
        transcriptId,
        subtitleMediaId: asset.id,
        subtitleKey: key,
        subtitleBucket: this.derived.kind,
        mediaId: alignTarget,
        kind: parsed.kind,
        timed: parsed.timed,
        cueCount: parsed.cues.length,
        language: document.language,
        segments: parsed.cues.map((cue) => ({
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text.replace(/\s+/g, " ").trim(),
        })),
        cueWordCounts: parsed.cues.map(
          (cue) => cue.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length,
        ),
      },
      jobKey: MEDIA_JOB_KEYS.align(asset.id),
      worstCaseTenths: MEDIA_JOB_QUOTES.alignTenths,
      reason: `ai.align · imported ${parsed.kind} · ${String(parsed.cues.length)} cues`,
    });
    if (parsed.warnings.length > 0) {
      this.logger.debug(
        { projectId: project.id, mediaId: asset.id, warnings: parsed.warnings.length },
        "subtitle import had warnings",
      );
    }

    return {
      mediaId: asset.id,
      kind: parsed.kind,
      key,
      cueCount: parsed.cues.length,
      timed: parsed.timed,
      warnings: parsed.warnings,
      jobId: job.job.id,
    };
  }

  /** The media the cues most likely belong to: the project's first primary item. */
  private async primaryMediaId(projectId: string): Promise<string | null> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return media?.id ?? null;
  }
}

/** `.srt`, `.vtt`, `.ass`/`.ssa` or `.txt` at the end of a URL path. */
export function kindFromUrl(url: string): SubtitleKind | undefined {
  const path = url.split("?")[0]?.split("#")[0] ?? "";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "ssa") return "ass";
  return isSubtitleKind(extension) ? extension : undefined;
}

function filenameFromUrl(url: string): string {
  const path = url.split("?")[0]?.split("#")[0] ?? "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "" ? "import" : name.slice(0, 255);
}

/**
 * Map a {@link SafeFetchError} onto an API error.
 *
 * A blocked address is `import/blocked_url` with **no detail**: telling the
 * caller "10.0.0.5 is RFC1918 private" would turn the import endpoint into a
 * port scanner with a helpful oracle attached, which is the T6 finding rather
 * than the fix for it.
 */
function importFetchError(error: unknown): AppException {
  if (error instanceof SafeFetchError) {
    switch (error.code) {
      case "blocked_address":
      case "blocked_scheme":
      case "blocked_port":
      case "dns_failed":
        return new AppException(
          IMPORT_ERRORS.blockedUrl,
          "That URL cannot be fetched.",
          HttpStatus.BAD_REQUEST,
        );
      case "too_large":
        return new AppException(
          IMPORT_ERRORS.tooLarge,
          `A subtitle import may be at most ${String(IMPORT_MAX_BYTES / (1024 * 1024))} MB.`,
          HttpStatus.PAYLOAD_TOO_LARGE,
          { maxBytes: IMPORT_MAX_BYTES },
        );
      case "too_many_redirects":
      case "timeout":
      case "request_failed":
        return new AppException(
          IMPORT_ERRORS.fetchFailed,
          "That URL could not be read.",
          HttpStatus.BAD_GATEWAY,
        );
    }
  }
  return new AppException(
    IMPORT_ERRORS.fetchFailed,
    "That URL could not be read.",
    HttpStatus.BAD_GATEWAY,
  );
}
