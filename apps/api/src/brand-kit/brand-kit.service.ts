import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  BRAND_KIT_VERSION,
  brandKitSettingsOf,
  DEFAULT_BRAND_KIT_SETTINGS,
  END_CARD_CTA_MAX,
  END_CARD_HANDLE_MAX,
  type BrandKitSettings,
  type OverlayImage,
} from "@montaj/edg";
import { CATALOGUE } from "@montaj/fonts";

import {
  BRAND_IMAGE_URL_TTL_SECONDS,
  BRAND_KIT_ERROR_CODES,
  contentTypeOfFormat,
  DEFAULT_BRAND_KIT_NAME,
  LOGO_ASSET_KIND,
  LOGO_CONTENT_TYPE_LIST,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  LOGO_MIN_SIDE,
  LOGO_UPLOAD_URL_TTL_SECONDS,
  type LogoContentType,
  type LogoFormat,
} from "./brand-kit.constants.js";
import { probeImage } from "./image-probe.js";
import { AppException, PrismaService } from "../common/index.js";
import { brandAssetKey, DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";

import type {
  BrandKitLogoView,
  BrandKitView,
  LogoCompleteInput,
  LogoUploadInput,
  LogoUploadTicket,
} from "./brand-kit.dto.js";
import type { BrandAsset, Prisma } from "@prisma/client";

/** Every typeface a kit may name: the families this product bundles (`@montaj/fonts`). */
export const BRAND_FONT_FAMILIES: readonly string[] = [
  ...new Set(CATALOGUE.map((family) => family.family)),
];

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** What Autopilot applies: the kit's settings, and its logo as an overlay draws it. */
export interface KitForClips {
  readonly settings: BrandKitSettings;
  /** Absent when the kit has no logo. */
  readonly logo?: OverlayImage;
}

/**
 * A workspace's brand kit (2026-10-02): its colours, typefaces, logo placement
 * and end card, one kit per workspace in v1.
 *
 * **Inert until saved.** A workspace with no `brand_kits` row reads the
 * defaults with `exists: false`, and Autopilot applies nothing for it
 * ({@link forClips} is `null`): no kit, exactly today's clips.
 *
 * **The logo.** Bytes go straight to R2 through a presigned PUT (like the
 * watermark), under `ws/{workspaceId}/brand/{assetId}.{png|jpg|webp}`. Then
 * `complete` reads them back — at most {@link LOGO_MAX_BYTES} — and keeps them
 * only if they open as the PNG, JPEG or WebP they were declared as, at a
 * sensible size, which it records for the renderers to size the logo by. The
 * logo is a `brand_assets` row of kind `logo` that the kit points at.
 *
 * **An old logo lives as long as a clip draws it.** Clips carry the logo they
 * were made with (the overlay names its asset), so replacing or removing the
 * kit's logo leaves existing clips untouched; a logo nothing draws any more —
 * not the kit, not any document in the workspace — is deleted, object then
 * row, whenever the kit's logo changes. Workspace erasure deletes them all.
 */
@Injectable()
export class BrandKitService {
  private readonly logger = new Logger(BrandKitService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
  ) {}

  /** `GET /brand-kit`. */
  async view(workspaceId: string): Promise<BrandKitView> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      include: { logoAsset: true },
    });
    const logos = await this.prisma.brandAsset.findMany({
      where: { workspaceId, kind: LOGO_ASSET_KIND },
      orderBy: { createdAt: "desc" },
    });
    const images: Record<string, string> = {};
    for (const logo of logos) {
      images[logo.id] = await this.store.presignGet(logo.storageKey, BRAND_IMAGE_URL_TTL_SECONDS);
    }
    const current = kit?.logoAsset ?? null;
    return {
      exists: kit !== null,
      settings: kit === null ? DEFAULT_BRAND_KIT_SETTINGS : brandKitSettingsOf(kit.doc),
      logo: current === null ? null : logoView(current, images[current.id] ?? ""),
      images,
      fontFamilies: [...BRAND_FONT_FAMILIES],
      limits: {
        logoMaxBytes: LOGO_MAX_BYTES,
        logoContentTypes: [...LOGO_CONTENT_TYPE_LIST],
        logoMinSide: LOGO_MIN_SIDE,
        logoMaxSide: LOGO_MAX_SIDE,
        ctaMax: END_CARD_CTA_MAX,
        handleMax: END_CARD_HANDLE_MAX,
      },
      updatedAt: kit === null ? null : kit.updatedAt.toISOString(),
    };
  }

  /**
   * `PUT /brand-kit`: the whole kit. Creates it the first time — from then on
   * Autopilot applies it to runs that ask for it.
   *
   * @throws AppException 400 `brand_kit/font_unknown` for a typeface this
   *   product does not bundle.
   */
  async update(workspaceId: string, settings: BrandKitSettings): Promise<BrandKitView> {
    for (const family of [settings.captions.fontFamily, settings.hookTitle.fontFamily]) {
      if (family !== undefined && !BRAND_FONT_FAMILIES.includes(family)) {
        throw new AppException(
          BRAND_KIT_ERROR_CODES.fontUnknown,
          `"${family}" is not one of the typefaces Aksharo can draw captions in.`,
          HttpStatus.BAD_REQUEST,
          { fontFamily: family },
        );
      }
    }
    const doc = { v: BRAND_KIT_VERSION, ...settings };
    await this.upsertKit(workspaceId, { doc }, { doc });
    return this.view(workspaceId);
  }

  /**
   * `POST /brand-kit/logo`: a presigned PUT for a new logo. Nothing is
   * recorded until `complete` has seen the bytes.
   *
   * @throws AppException 413 `brand_kit/logo_too_large`.
   */
  async createLogoUpload(workspaceId: string, input: LogoUploadInput): Promise<LogoUploadTicket> {
    if (input.sizeBytes > LOGO_MAX_BYTES) throw tooLarge(input.sizeBytes);
    const assetId = ulid();
    const key = brandAssetKey(
      workspaceId,
      assetId,
      LOGO_CONTENT_TYPES[input.contentType].extension,
    );
    const uploadUrl = await this.store.presignPut(
      key,
      LOGO_UPLOAD_URL_TTL_SECONDS,
      input.contentType,
    );
    return {
      assetId,
      uploadUrl,
      contentType: input.contentType,
      expiresAt: new Date(Date.now() + LOGO_UPLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
      maxBytes: LOGO_MAX_BYTES,
    };
  }

  /**
   * `POST /brand-kit/logo/{assetId}/complete`: checks the uploaded bytes and
   * makes them the kit's logo (creating the kit with its defaults if there is
   * none yet). A file that is not what it claims, too large, or an unusable
   * size is deleted and refused. Idempotent: completing the same upload again
   * answers the same kit.
   *
   * @returns the kit, and the logo it replaced (null for none).
   */
  async completeLogo(
    workspaceId: string,
    userId: string | null,
    assetId: string,
    input: LogoCompleteInput,
  ): Promise<{ readonly view: BrandKitView; readonly replaced: string | null }> {
    if (!ULID_PATTERN.test(assetId)) throw logoNotFound();
    const existing = await this.prisma.brandAsset.findUnique({ where: { id: assetId } });
    if (existing !== null) {
      if (existing.workspaceId !== workspaceId || existing.kind !== LOGO_ASSET_KIND) {
        throw logoNotFound();
      }
      const replaced = await this.pointKitAt(workspaceId, assetId);
      return { view: await this.view(workspaceId), replaced };
    }

    const type = LOGO_CONTENT_TYPES[input.contentType];
    const key = brandAssetKey(workspaceId, assetId, type.extension);
    const head = await this.store.head(key);
    if (head === null) {
      throw new AppException(
        BRAND_KIT_ERROR_CODES.logoNotUploaded,
        "The logo has not finished uploading. Try again in a moment.",
        HttpStatus.CONFLICT,
      );
    }
    if (head.sizeBytes > LOGO_MAX_BYTES) {
      await this.discard(key);
      throw tooLarge(head.sizeBytes);
    }
    const bytes = new Uint8Array(await this.store.get(key));
    if (bytes.byteLength > LOGO_MAX_BYTES) {
      await this.discard(key);
      throw tooLarge(bytes.byteLength);
    }
    const facts = probeImage(bytes);
    if (facts === undefined || facts.format !== type.format) {
      await this.discard(key);
      throw new AppException(
        BRAND_KIT_ERROR_CODES.logoInvalid,
        "That file is not a PNG, JPEG or WebP image.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const sides = [facts.width, facts.height];
    if (sides.some((side) => side < LOGO_MIN_SIDE || side > LOGO_MAX_SIDE)) {
      await this.discard(key);
      throw new AppException(
        BRAND_KIT_ERROR_CODES.logoBadSize,
        `A logo must be between ${String(LOGO_MIN_SIDE)} and ${String(LOGO_MAX_SIDE)} pixels on each side; this one is ${String(facts.width)} × ${String(facts.height)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { width: facts.width, height: facts.height },
      );
    }

    await this.prisma.brandAsset.create({
      data: {
        id: assetId,
        workspaceId,
        kind: LOGO_ASSET_KIND,
        storageKey: key,
        contentType: input.contentType,
        sizeBytes: bytes.byteLength,
        width: facts.width,
        height: facts.height,
        createdBy: userId,
      },
    });
    const replaced = await this.pointKitAt(workspaceId, assetId);
    await this.collectUnusedLogos(workspaceId);
    return { view: await this.view(workspaceId), replaced };
  }

  /**
   * `DELETE /brand-kit/logo`: the kit stops adding a logo to new clips. Clips
   * that already carry it keep it (see the class comment); a logo nothing draws
   * is deleted. Idempotent.
   */
  async removeLogo(
    workspaceId: string,
  ): Promise<{ readonly view: BrandKitView; readonly removed: string | null }> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      select: { id: true, logoAssetId: true },
    });
    const removed = kit?.logoAssetId ?? null;
    if (kit !== null && removed !== null) {
      await this.prisma.brandKit.update({ where: { id: kit.id }, data: { logoAssetId: null } });
    }
    await this.collectUnusedLogos(workspaceId);
    return { view: await this.view(workspaceId), removed };
  }

  /**
   * What Autopilot applies to a run's clips: the saved kit and its logo, or
   * `null` when the workspace has never saved one — which is what keeps a
   * workspace without a kit on exactly today's clips.
   */
  async forClips(workspaceId: string): Promise<KitForClips | null> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      include: { logoAsset: true },
    });
    if (kit === null) return null;
    const logo = kit.logoAsset === null ? undefined : overlayImageOf(kit.logoAsset);
    return { settings: brandKitSettingsOf(kit.doc), ...(logo === undefined ? {} : { logo }) };
  }

  /**
   * Which of `assetIds` the workspace still keeps as logos. A render payload
   * and a preview draw only these: an overlay naming a logo that is gone draws
   * without it rather than failing.
   */
  async availableImages(workspaceId: string, assetIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(assetIds)].filter((id) => ULID_PATTERN.test(id));
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.brandAsset.findMany({
      where: { workspaceId, kind: LOGO_ASSET_KIND, id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /** Signed URLs for the logos among `assetIds` the workspace still keeps, by asset id. */
  async imageUrls(
    workspaceId: string,
    assetIds: readonly string[],
    ttlSeconds: number = BRAND_IMAGE_URL_TTL_SECONDS,
  ): Promise<Record<string, string>> {
    const ids = [...new Set(assetIds)].filter((id) => ULID_PATTERN.test(id));
    if (ids.length === 0) return {};
    const rows = await this.prisma.brandAsset.findMany({
      where: { workspaceId, kind: LOGO_ASSET_KIND, id: { in: ids } },
      select: { id: true, storageKey: true },
    });
    const urls: Record<string, string> = {};
    for (const row of rows) urls[row.id] = await this.store.presignGet(row.storageKey, ttlSeconds);
    return urls;
  }

  /**
   * Creates the workspace's one kit with `create`, or changes it with `update`.
   * Two first writes at once (a save and a logo upload) both try to create it,
   * and the unique `workspace_id` refuses the second; asked again, it finds
   * the row the first made and updates that.
   */
  private async upsertKit(
    workspaceId: string,
    create: { readonly doc: Prisma.InputJsonValue; readonly logoAssetId?: string },
    update: { readonly doc?: Prisma.InputJsonValue; readonly logoAssetId?: string },
  ): Promise<void> {
    const write = () =>
      this.prisma.brandKit.upsert({
        where: { workspaceId },
        create: {
          id: ulid(),
          workspaceId,
          name: DEFAULT_BRAND_KIT_NAME,
          isDefault: true,
          ...create,
        },
        update,
      });
    try {
      await write();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await write();
    }
  }

  /** Makes `assetId` the kit's logo, creating the kit if there is none. Returns the logo it replaced. */
  private async pointKitAt(workspaceId: string, assetId: string): Promise<string | null> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      select: { id: true, logoAssetId: true },
    });
    if (kit === null) {
      await this.upsertKit(
        workspaceId,
        { doc: { v: BRAND_KIT_VERSION, ...DEFAULT_BRAND_KIT_SETTINGS }, logoAssetId: assetId },
        { logoAssetId: assetId },
      );
      return null;
    }
    if (kit.logoAssetId === assetId) return null;
    await this.prisma.brandKit.update({ where: { id: kit.id }, data: { logoAssetId: assetId } });
    return kit.logoAssetId;
  }

  /**
   * Deletes every logo of the workspace that nothing draws any more: not the
   * kit's, and named by no editing document in the workspace. Best effort,
   * object first then row (the order retention uses), and never fatal: a logo
   * that could not be deleted now is looked at again on the next change.
   */
  async collectUnusedLogos(workspaceId: string): Promise<number> {
    let deleted = 0;
    try {
      const kit = await this.prisma.brandKit.findUnique({
        where: { workspaceId },
        select: { logoAssetId: true },
      });
      const logos = await this.prisma.brandAsset.findMany({
        where: { workspaceId, kind: LOGO_ASSET_KIND },
        select: { id: true, storageKey: true },
      });
      for (const logo of logos) {
        if (logo.id === kit?.logoAssetId) continue;
        if (await this.documentsDraw(workspaceId, logo.id)) continue;
        await this.store.delete(logo.storageKey);
        await this.prisma.brandAsset.delete({ where: { id: logo.id } });
        deleted += 1;
      }
    } catch (error) {
      this.logger.warn(
        { workspaceId, err: error },
        "could not tidy the workspace's unused logos; they are looked at again on the next change",
      );
    }
    return deleted;
  }

  /**
   * Whether any editing document in the workspace names `assetId` — an overlay
   * is the only place a document can. `assetId` is a checked ULID, so it holds
   * no `LIKE` wildcard; the query is parameterised all the same.
   */
  private async documentsDraw(workspaceId: string, assetId: string): Promise<boolean> {
    if (!ULID_PATTERN.test(assetId)) return true;
    const rows = await this.prisma.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found
        FROM edg_documents d
        JOIN projects p ON p.id = d.project_id
       WHERE p.workspace_id = ${workspaceId}
         AND d.doc::text LIKE ${`%${assetId}%`}
       LIMIT 1`;
    return rows.length > 0;
  }

  private async discard(key: string): Promise<void> {
    await this.store.delete(key).catch((error: unknown) => {
      this.logger.warn({ key, err: error }, "could not delete a refused logo upload");
    });
  }
}

/** A stored logo as an overlay names it. */
export function overlayImageOf(asset: BrandAsset): OverlayImage | undefined {
  const type = LOGO_CONTENT_TYPES[asset.contentType as LogoContentType] as
    (typeof LOGO_CONTENT_TYPES)[LogoContentType] | undefined;
  if (type === undefined || asset.width === null || asset.height === null) return undefined;
  return { assetId: asset.id, format: type.format, width: asset.width, height: asset.height };
}

function logoView(asset: BrandAsset, url: string): BrandKitLogoView | null {
  const image = overlayImageOf(asset);
  if (image === undefined) return null;
  return {
    assetId: asset.id,
    format: image.format,
    contentType: contentTypeOfFormat(image.format as LogoFormat),
    width: image.width,
    height: image.height,
    sizeBytes: asset.sizeBytes,
    url,
  };
}

/** A unique constraint refused the write (Prisma `P2002`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function tooLarge(sizeBytes: number): AppException {
  return new AppException(
    BRAND_KIT_ERROR_CODES.logoTooLarge,
    `A logo can be at most ${String(LOGO_MAX_BYTES / (1024 * 1024))} MB.`,
    HttpStatus.PAYLOAD_TOO_LARGE,
    { sizeBytes, maxBytes: LOGO_MAX_BYTES },
  );
}

function logoNotFound(): AppException {
  return new AppException(
    BRAND_KIT_ERROR_CODES.logoNotFound,
    "No such logo upload.",
    HttpStatus.NOT_FOUND,
  );
}
