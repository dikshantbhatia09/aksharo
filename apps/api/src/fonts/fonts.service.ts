import { type FontManifest, type ScriptTag } from "@montaj/fonts";
import { FontSubsetError, FontValidationError, processFont } from "@montaj/fonts/node";
import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  ACCEPTED_ATTESTATION_VERSIONS,
  customFontLimitFor,
  FONT_ATTESTATION,
  FONT_DOWNLOAD_URL_TTL_SECONDS,
  FONT_ERRORS,
  FONT_OBJECT_TAGS,
  FONT_UPLOAD_URL_TTL_SECONDS,
  MAX_FONT_UPLOAD_BYTES,
  readFontMetrics,
  type FontMetrics,
} from "./fonts.constants.js";
import { AppException, PrismaService } from "../common/index.js";
import {
  DERIVED_STORE,
  extensionOf,
  fontKey,
  type FontExtension,
  type ObjectStore,
} from "../common/storage/index.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { InitFontUploadDto } from "./fonts.dto.js";
import type { Font } from "@prisma/client";

export interface WorkspaceFontView {
  readonly id: string;
  readonly workspaceId: string;
  readonly family: string;
  readonly style: string;
  readonly status: "pending" | "ready" | "failed";
  readonly sanitised: boolean;
  readonly weight: number;
  readonly italic: boolean;
  readonly scripts: readonly string[];
  readonly sizeBytes: number | null;
  readonly woff2SizeBytes: number | null;
  readonly filename: string | null;
  readonly licenceAttestedBy: string | null;
  readonly attestedAt: string | null;
  readonly attestationVersion: string | null;
  readonly licenceNote: string | null;
  readonly servedOnlyToWorkspace: boolean;
  readonly createdAt: string;
}

export interface FontUploadTicket {
  readonly fontId: string;
  readonly url: string;
  readonly key: string;
  readonly expiresAt: string;
  readonly attestation: { readonly version: string; readonly text: string };
  readonly quota: { readonly used: number; readonly limit: number; readonly planKey: string };
  readonly font: WorkspaceFontView;
}

export interface FontUrls {
  readonly fontId: string;
  readonly url: string;
  readonly woff2Url?: string;
  readonly expiresAt: string;
}

export interface CompleteFontInput {
  readonly licenceAttested: boolean;
  readonly licenceNote?: string;
  readonly attestationVersion?: string;
}

/**
 * Custom fonts: upload, licence attestation, sanitisation, scoped serving.
 *
 * ```
 * init  -> plan check -> row -> presigned PUT  (bytes go straight to R2)
 * PUT   -> the browser uploads
 * complete -> attestation -> HEAD -> GET -> validate -> subset -> woff2 -> PUT
 * ```
 *
 * **Where the work happens.** Validation and subsetting run *inline* here rather
 * than on a queue. The brief asked for a `media.font` queue, and CONTRACTS §3 —
 * frozen — does not have one; A05 hit the same wall with the rights export and
 * took the same way out. The cost is bounded and small: an 8 MiB cap, one
 * `hb-subset` pass in wasm, a few hundred milliseconds. The pipeline itself
 * lives in `@montaj/fonts` as a pure function, so moving it onto a queue when
 * CONTRACTS §3 names one is a producer call here and a processor there, with no
 * second implementation to keep honest.
 *
 * **What is stored, and why two objects.** CONTRACTS §6 gives fonts exactly one
 * key shape, `ws/{workspaceId}/fonts/{fontId}.{ttf|otf|woff2}`. So the original,
 * validated face goes to `{fontId}.{ttf|otf}` — which is what the cloud renderer
 * and the desktop app register — and the subset goes to `{fontId}.woff2`, which
 * is what the browser fetches and decompresses. No third slot exists and none is
 * needed: decompressing the WOFF2 gives the subset back.
 *
 * **Tenancy.** Every read joins through `workspaceId`, so a font id from another
 * workspace matches nothing and answers 404 (THREAT-MODEL T5), and every URL is
 * signed for five minutes against a key this service built from ids it checked.
 * `servedOnlyToWorkspace` is written `true` and never read as a permission — the
 * permission is the join.
 */
@Injectable()
export class FontsService {
  private readonly logger = new Logger(FontsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(workspaceId: string): Promise<WorkspaceFontView[]> {
    const rows = await this.prisma.font.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    });
    return rows.map(toFontView);
  }

  /**
   * The workspace's fonts as a `@montaj/fonts` manifest, with signed URLs.
   *
   * The same shape `GET /fonts/manifest` returns for the bundled pack, so one
   * loader in the browser and one in the cloud renderer read both.
   */
  async manifest(workspaceId: string): Promise<FontManifest & { expiresAt: string }> {
    const rows = await this.prisma.font.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    });
    const ready = rows.filter((row) => readFontMetrics(row.metrics).status === "ready");
    const expiresAt = new Date(Date.now() + FONT_DOWNLOAD_URL_TTL_SECONDS * 1_000).toISOString();

    const fonts = await Promise.all(
      ready.map(async (row) => {
        const metrics = readFontMetrics(row.metrics);
        const woff2Key = row.subsetKey;
        return {
          id: row.id,
          family: row.family,
          weight: metrics.weight,
          italic: metrics.italic,
          file: fileNameOf(row.storageKey),
          scripts: metrics.wordScripts.length > 0 ? metrics.wordScripts : (["other"] as const),
          scriptTags: metrics.scripts,
          ...(woff2Key === null ? {} : { woff2: fileNameOf(woff2Key) }),
          sizeBytes: Number(row.sizeBytes ?? 0),
          ...(metrics.woff2SizeBytes === undefined
            ? {}
            : { woff2SizeBytes: metrics.woff2SizeBytes }),
          sha256: metrics.sha256 ?? "0".repeat(64),
          url: await this.store.presignGet(row.storageKey, FONT_DOWNLOAD_URL_TTL_SECONDS),
          ...(woff2Key === null
            ? {}
            : { woff2Url: await this.store.presignGet(woff2Key, FONT_DOWNLOAD_URL_TTL_SECONDS) }),
        };
      }),
    );

    return {
      v: 1,
      origin: "workspace",
      generatedAt: new Date().toISOString(),
      fonts: fonts as FontManifest["fonts"],
      expiresAt,
    };
  }

  /**
   * One font, joined through its workspace.
   *
   * The workspace is part of the query rather than compared afterwards, so a
   * font id from another tenant matches nothing and answers 404.
   */
  async require(workspaceId: string, fontId: string): Promise<Font> {
    const font = await this.prisma.font.findFirst({ where: { id: fontId, workspaceId } });
    if (font === null) {
      throw new AppException(FONT_ERRORS.notFound, "No such font.", HttpStatus.NOT_FOUND, {
        fontId,
      });
    }
    return font;
  }

  async get(workspaceId: string, fontId: string): Promise<WorkspaceFontView> {
    return toFontView(await this.require(workspaceId, fontId));
  }

  /** Short-lived download URLs for one font, scoped to the owning workspace. */
  async urls(workspaceId: string, fontId: string): Promise<FontUrls> {
    const font = await this.require(workspaceId, fontId);
    const metrics = readFontMetrics(font.metrics);
    if (metrics.status !== "ready") {
      throw new AppException(
        FONT_ERRORS.invalidState,
        "The font has not been sanitised yet.",
        HttpStatus.CONFLICT,
        { status: metrics.status },
      );
    }
    return {
      fontId: font.id,
      url: await this.store.presignGet(font.storageKey, FONT_DOWNLOAD_URL_TTL_SECONDS),
      ...(font.subsetKey === null
        ? {}
        : {
            woff2Url: await this.store.presignGet(font.subsetKey, FONT_DOWNLOAD_URL_TTL_SECONDS),
          }),
      expiresAt: new Date(Date.now() + FONT_DOWNLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------

  /**
   * `POST /workspaces/{id}/fonts/init`.
   *
   * The plan limit is checked before anything is signed, and it counts rows
   * rather than ready fonts: an abandoned upload holds a slot until it is
   * deleted, which is the honest accounting — the object is in the bucket.
   */
  async initUpload(workspaceId: string, input: InitFontUploadDto): Promise<FontUploadTicket> {
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    const limit = customFontLimitFor(entitlement);
    const used = await this.prisma.font.count({ where: { workspaceId } });
    if (used >= limit) {
      throw new AppException(
        FONT_ERRORS.planLimit,
        limit === 0
          ? "Custom fonts are not included in this plan."
          : `This plan allows ${String(limit)} custom fonts.`,
        HttpStatus.FORBIDDEN,
        { used, limit, planKey: entitlement.planKey, requiredPlan: "starter" },
      );
    }
    if (input.sizeBytes > MAX_FONT_UPLOAD_BYTES) {
      throw new AppException(
        FONT_ERRORS.tooLarge,
        `A font may be at most ${String(MAX_FONT_UPLOAD_BYTES)} bytes.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { sizeBytes: input.sizeBytes, maxBytes: MAX_FONT_UPLOAD_BYTES },
      );
    }

    const fontId = ulid();
    const extension = sfntExtensionFor(input.filename);
    const key = fontKey(workspaceId, fontId, extension);
    const metrics: FontMetrics = {
      status: "pending",
      sanitised: false,
      scripts: input.scripts ?? [],
      wordScripts: [],
      weight: 400,
      italic: false,
      coverage: {},
      originalSizeBytes: input.sizeBytes,
      filename: input.filename,
    };

    const created = await this.prisma.font.create({
      data: {
        id: fontId,
        workspaceId,
        family: input.family ?? stemOf(input.filename),
        style: "regular",
        storageKey: key,
        sizeBytes: BigInt(input.sizeBytes),
        metrics,
        servedOnlyToWorkspace: true,
      },
    });

    return {
      fontId,
      url: await this.store.presignPut(key, FONT_UPLOAD_URL_TTL_SECONDS, contentTypeFor(extension)),
      key,
      expiresAt: new Date(Date.now() + FONT_UPLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
      attestation: { version: FONT_ATTESTATION.version, text: FONT_ATTESTATION.text },
      quota: { used: used + 1, limit, planKey: entitlement.planKey },
      font: toFontView(created),
    };
  }

  /**
   * `POST /fonts/{fontId}/complete` — attest, sanitise, subset, publish.
   *
   * The order is the design: **the attestation is refused before the bytes are
   * read**, because an unattested font is not one we are willing to process; and
   * the font is **validated before it is subset**, because the subsetter is the
   * expensive step and a hostile file should not reach it (T7).
   *
   * Idempotent: completing a font that is already ready returns it unchanged.
   */
  async complete(
    workspaceId: string,
    fontId: string,
    userId: string,
    input: CompleteFontInput,
  ): Promise<WorkspaceFontView> {
    const font = await this.require(workspaceId, fontId);
    const existing = readFontMetrics(font.metrics);
    if (existing.status === "ready") return toFontView(font);

    if (input.licenceAttested !== true) {
      throw new AppException(
        FONT_ERRORS.attestationRequired,
        "A custom font may only be used once its uploader warrants they are licensed to embed it.",
        HttpStatus.UNPROCESSABLE_ENTITY,
        { attestation: FONT_ATTESTATION },
      );
    }
    const version = input.attestationVersion ?? FONT_ATTESTATION.version;
    if (!ACCEPTED_ATTESTATION_VERSIONS.includes(version)) {
      throw new AppException(
        FONT_ERRORS.attestationStale,
        "The licence warranty has changed; show the current text and attest again.",
        HttpStatus.CONFLICT,
        { given: version, current: FONT_ATTESTATION.version },
      );
    }

    const head = await this.store.head(font.storageKey);
    if (head === null) {
      throw new AppException(
        FONT_ERRORS.uploadMissing,
        "The font was never uploaded.",
        HttpStatus.CONFLICT,
        { key: font.storageKey },
      );
    }
    if (head.sizeBytes > MAX_FONT_UPLOAD_BYTES) {
      await this.discard(font, "fonts/too_large");
      throw new AppException(
        FONT_ERRORS.tooLarge,
        `A font may be at most ${String(MAX_FONT_UPLOAD_BYTES)} bytes.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { sizeBytes: head.sizeBytes, maxBytes: MAX_FONT_UPLOAD_BYTES },
      );
    }

    const bytes = new Uint8Array(await this.store.get(font.storageKey));
    let processed: Awaited<ReturnType<typeof processFont>>;
    try {
      processed = await processFont({
        bytes,
        ...(existing.scripts.length > 0 ? { claimedScripts: existing.scripts as ScriptTag[] } : {}),
        maxBytes: MAX_FONT_UPLOAD_BYTES,
      });
    } catch (error) {
      if (error instanceof FontValidationError || error instanceof FontSubsetError) {
        // The object is refused, so it does not stay in the bucket: an upload
        // that failed validation is not the workspace's font and must not eat
        // its plan quota either.
        await this.discard(font, error.code);
        throw new AppException(
          error.code,
          error.message,
          HttpStatus.UNPROCESSABLE_ENTITY,
          error instanceof FontValidationError ? error.details : undefined,
        );
      }
      throw error;
    }

    const woff2Key = fontKey(workspaceId, fontId, "woff2");
    await this.store.put({
      key: woff2Key,
      body: processed.woff2,
      contentType: "font/woff2",
      tags: FONT_OBJECT_TAGS,
    });
    await this.store.tag(font.storageKey, FONT_OBJECT_TAGS);

    const metrics: FontMetrics = {
      status: "ready",
      sanitised: true,
      scripts: [...processed.scripts],
      wordScripts: [...processed.wordScripts],
      weight: processed.validation.weight,
      italic: processed.validation.italic,
      unitsPerEm: processed.validation.unitsPerEm,
      ascent: processed.validation.ascent,
      descent: processed.validation.descent,
      lineGap: processed.validation.lineGap,
      numGlyphs: processed.validation.numGlyphs,
      coverage: processed.validation.coverage,
      format: processed.validation.format,
      originalSizeBytes: head.sizeBytes,
      woff2SizeBytes: processed.woff2.byteLength,
      sha256: processed.sha256Original,
      woff2Sha256: processed.sha256Woff2,
      attestationVersion: version,
      ...(existing.filename === undefined ? {} : { filename: existing.filename }),
    };

    const updated = await this.prisma.font.update({
      where: { id: font.id },
      data: {
        // The font's own family name wins over whatever the uploader typed: the
        // registry resolves by family and a StyleDoc will name what the font
        // calls itself.
        family: processed.validation.family,
        style: styleNameFor(processed.validation.weight, processed.validation.italic),
        subsetKey: woff2Key,
        sizeBytes: BigInt(head.sizeBytes),
        metrics,
        licenceAttestedBy: userId,
        attestedAt: new Date(),
        licenceNote: input.licenceNote ?? null,
        servedOnlyToWorkspace: true,
      },
    });

    this.logger.log(
      {
        fontId,
        workspaceId,
        family: updated.family,
        scripts: processed.scripts,
        sizeBytes: head.sizeBytes,
        woff2SizeBytes: processed.woff2.byteLength,
      },
      "custom font sanitised and subset",
    );
    return toFontView(updated);
  }

  // -------------------------------------------------------------------------
  // Deleting
  // -------------------------------------------------------------------------

  /** Delete one font and both of its objects. */
  async remove(workspaceId: string, fontId: string): Promise<{ readonly deleted: true }> {
    const font = await this.require(workspaceId, fontId);
    await this.deleteObjects(font);
    await this.prisma.font.delete({ where: { id: font.id } });
    return { deleted: true };
  }

  /**
   * Every font object a workspace owns, deleted — the erasure cascade's half of
   * the job (D70).
   *
   * The `fonts` rows go with the workspace (`onDelete: Cascade`), which leaves
   * the bytes; this is what deletes them. B16 owns the sweep that calls it, the
   * same way it owns the media purge, and it is here rather than there so the
   * key shape stays in the module that writes it.
   */
  async purgeWorkspace(workspaceId: string): Promise<{ readonly objects: number }> {
    const rows = await this.prisma.font.findMany({ where: { workspaceId } });
    const keys = rows.flatMap((row) =>
      row.subsetKey === null ? [row.storageKey] : [row.storageKey, row.subsetKey],
    );
    if (keys.length === 0) return { objects: 0 };
    const deleted = await this.store.deleteMany(keys);
    return { objects: deleted };
  }

  /** Drop a refused upload: both objects and the row. */
  private async discard(font: Font, code: string): Promise<void> {
    await this.deleteObjects(font);
    await this.prisma.font.delete({ where: { id: font.id } }).catch((error: unknown) => {
      this.logger.warn({ err: error, fontId: font.id }, "could not delete a refused font row");
    });
    this.logger.log({ fontId: font.id, code }, "custom font refused and discarded");
  }

  private async deleteObjects(font: Font): Promise<void> {
    const keys = font.subsetKey === null ? [font.storageKey] : [font.storageKey, font.subsetKey];
    await this.store.deleteMany(keys).catch((error: unknown) => {
      this.logger.warn({ err: error, fontId: font.id }, "could not delete font objects");
      return 0;
    });
  }
}

/** `regular`, `bold`, `italic`, `bold italic`, `600`, ... for `fonts.style`. */
export function styleNameFor(weight: number, italic: boolean): string {
  const base = weight === 400 ? "regular" : weight === 700 ? "bold" : String(weight);
  return italic ? (base === "regular" ? "italic" : `${base} italic`) : base;
}

/** The last segment of a storage key, which is the manifest's `file`. */
export function fileNameOf(key: string): string {
  return key.split("/").pop() ?? key;
}

/** The container extension to sign the upload for; OTF keeps its own name. */
export function sfntExtensionFor(filename: string): FontExtension {
  return extensionOf(filename) === "otf" ? "otf" : "ttf";
}

function contentTypeFor(extension: FontExtension): string {
  return extension === "otf" ? "font/otf" : extension === "woff2" ? "font/woff2" : "font/ttf";
}

/** A filename without its extension, as a first guess at the family name. */
export function stemOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim().length === 0 ? "Custom font" : stem.trim().slice(0, 128);
}

export function toFontView(font: Font): WorkspaceFontView {
  const metrics = readFontMetrics(font.metrics);
  return {
    id: font.id,
    workspaceId: font.workspaceId,
    family: font.family,
    style: font.style,
    status: metrics.status,
    sanitised: metrics.sanitised,
    weight: metrics.weight,
    italic: metrics.italic,
    scripts: metrics.scripts,
    sizeBytes: font.sizeBytes === null ? null : Number(font.sizeBytes),
    woff2SizeBytes: metrics.woff2SizeBytes ?? null,
    filename: metrics.filename ?? null,
    licenceAttestedBy: font.licenceAttestedBy,
    attestedAt: font.attestedAt?.toISOString() ?? null,
    attestationVersion: metrics.attestationVersion ?? null,
    licenceNote: font.licenceNote,
    servedOnlyToWorkspace: font.servedOnlyToWorkspace,
    createdAt: font.createdAt.toISOString(),
  };
}
