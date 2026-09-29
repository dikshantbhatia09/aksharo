import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  BRAND_KIT_VERSION,
  brandKitSettingsOf,
  DEFAULT_BRAND_KIT_SETTINGS,
  END_CARD_CTA_MAX,
  END_CARD_HANDLE_MAX,
  type BrandKitSettings,
  type BrandMusicTrack,
  type OverlayImage,
} from "@montaj/edg";
import { CATALOGUE } from "@montaj/fonts";

import { probeAudio } from "./audio-probe.js";
import {
  BRAND_IMAGE_URL_TTL_SECONDS,
  BRAND_KIT_ERROR_CODES,
  contentTypeOfFormat,
  COVER_ASSET_KIND,
  COVER_ERROR_CODES,
  COVER_MAX_BYTES,
  COVER_MAX_SIDE,
  COVER_MIN_SIDE,
  DEFAULT_BRAND_KIT_NAME,
  LOGO_ASSET_KIND,
  LOGO_CONTENT_TYPE_LIST,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  LOGO_MIN_SIDE,
  LOGO_UPLOAD_URL_TTL_SECONDS,
  MUSIC_ASSET_KIND,
  MUSIC_CONTENT_TYPE_LIST,
  MUSIC_CONTENT_TYPES,
  MUSIC_MAX_BYTES,
  MUSIC_MAX_DURATION_MS,
  MUSIC_MIN_DURATION_MS,
  type LogoContentType,
  type LogoFormat,
  type MusicContentType,
} from "./brand-kit.constants.js";
import { probeImage, type ImageFacts } from "./image-probe.js";
import { AppException, PrismaService } from "../common/index.js";
import { brandAssetKey, DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";

import type {
  BrandKitLogoView,
  BrandKitMusicView,
  BrandKitView,
  CoverView,
  LogoCompleteInput,
  LogoUploadInput,
  LogoUploadTicket,
  MusicCompleteInput,
  MusicUploadInput,
  MusicUploadTicket,
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
  /** The kit's own music (2026-10-04), as a bed names it; absent when it has none. */
  readonly music?: BrandMusicTrack;
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
 *
 * **Music** (2026-10-04) is kept the same way: an MP3, WAV or M4A uploaded
 * through a presigned PUT under the same prefix, read back and kept only if it
 * opens as what it claims (`audio-probe.ts`) and is between
 * {@link MUSIC_MIN_DURATION_MS} and {@link MUSIC_MAX_DURATION_MS} long, with
 * the person's "I have the rights to use this music" confirmation - required -
 * recorded on the row with who gave it and when. The kit points at its current
 * track; a track no clip's bed names any more is deleted when it changes.
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
      include: { logoAsset: true, musicAsset: true },
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
    const music = kit?.musicAsset ?? null;
    return {
      exists: kit !== null,
      settings: kit === null ? DEFAULT_BRAND_KIT_SETTINGS : brandKitSettingsOf(kit.doc),
      logo: current === null ? null : logoView(current, images[current.id] ?? ""),
      music:
        music === null
          ? null
          : musicView(
              music,
              await this.store.presignGet(music.storageKey, BRAND_IMAGE_URL_TTL_SECONDS),
            ),
      images,
      fontFamilies: [...BRAND_FONT_FAMILIES],
      limits: {
        logoMaxBytes: LOGO_MAX_BYTES,
        logoContentTypes: [...LOGO_CONTENT_TYPE_LIST],
        logoMinSide: LOGO_MIN_SIDE,
        logoMaxSide: LOGO_MAX_SIDE,
        ctaMax: END_CARD_CTA_MAX,
        handleMax: END_CARD_HANDLE_MAX,
        musicMaxBytes: MUSIC_MAX_BYTES,
        musicContentTypes: [...MUSIC_CONTENT_TYPE_LIST],
        musicMinDurationMs: MUSIC_MIN_DURATION_MS,
        musicMaxDurationMs: MUSIC_MAX_DURATION_MS,
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
    const { facts, sizeBytes } = await this.checkUploadedImage(key, type.format, LOGO_RULES);

    await this.prisma.brandAsset.create({
      data: {
        id: assetId,
        workspaceId,
        kind: LOGO_ASSET_KIND,
        storageKey: key,
        contentType: input.contentType,
        sizeBytes,
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
   * `POST /repurpose/covers` (2026-10-04, audiograms): a presigned PUT for the
   * cover a run started from an audio file is drawn with. Nothing is recorded
   * until {@link completeCover} has seen the bytes.
   *
   * @throws AppException 413 `repurpose/cover_too_large`.
   */
  async createCoverUpload(workspaceId: string, input: LogoUploadInput): Promise<LogoUploadTicket> {
    if (input.sizeBytes > COVER_MAX_BYTES) throw COVER_RULES.tooLarge(input.sizeBytes);
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
      maxBytes: COVER_MAX_BYTES,
    };
  }

  /**
   * `POST /repurpose/covers/{assetId}/complete`: keeps the uploaded bytes when
   * they open as the PNG, JPEG or WebP they were declared as, at a usable
   * size; otherwise deletes them and refuses. Idempotent. The answer's
   * `assetId` is what the start form sends as `setup.audiogram.coverAssetId`.
   */
  async completeCover(
    workspaceId: string,
    userId: string | null,
    assetId: string,
    input: LogoCompleteInput,
  ): Promise<CoverView> {
    if (!ULID_PATTERN.test(assetId)) throw coverNotFound();
    const existing = await this.prisma.brandAsset.findUnique({ where: { id: assetId } });
    if (existing !== null) {
      if (existing.workspaceId !== workspaceId || existing.kind !== COVER_ASSET_KIND) {
        throw coverNotFound();
      }
      return this.coverView(existing);
    }

    const type = LOGO_CONTENT_TYPES[input.contentType];
    const key = brandAssetKey(workspaceId, assetId, type.extension);
    const { facts, sizeBytes } = await this.checkUploadedImage(key, type.format, COVER_RULES);
    const row = await this.prisma.brandAsset.create({
      data: {
        id: assetId,
        workspaceId,
        kind: COVER_ASSET_KIND,
        storageKey: key,
        contentType: input.contentType,
        sizeBytes,
        width: facts.width,
        height: facts.height,
        createdBy: userId,
      },
    });
    return this.coverView(row);
  }

  /**
   * Whether `assetId` is a cover this workspace keeps: what `POST
   * /repurpose/runs` checks `setup.audiogram.coverAssetId` against.
   */
  async coverExists(workspaceId: string, assetId: string): Promise<boolean> {
    return (await this.coverArtwork(workspaceId, assetId)) !== null;
  }

  /**
   * A run's cover as an audiogram draws it: its object and its type, or
   * `null` when the workspace no longer keeps it (the clip is then drawn with
   * the next artwork there is, or none).
   */
  async coverArtwork(workspaceId: string, assetId: string): Promise<ArtworkObject | null> {
    if (!ULID_PATTERN.test(assetId)) return null;
    const row = await this.prisma.brandAsset.findUnique({ where: { id: assetId } });
    if (row === null || row.workspaceId !== workspaceId || row.kind !== COVER_ASSET_KIND) {
      return null;
    }
    const format = formatOfContentType(row.contentType);
    return format === undefined ? null : { key: row.storageKey, format };
  }

  /** The kit's logo as an audiogram draws it: the object it was uploaded to. */
  logoArtwork(workspaceId: string, logo: OverlayImage): ArtworkObject {
    const format = logo.format as LogoFormat;
    const extension = LOGO_CONTENT_TYPES[contentTypeOfFormat(format)].extension;
    return { key: brandAssetKey(workspaceId, logo.assetId, extension), format };
  }

  private async coverView(row: BrandAsset): Promise<CoverView> {
    return {
      assetId: row.id,
      format: formatOfContentType(row.contentType) ?? "png",
      width: row.width ?? 0,
      height: row.height ?? 0,
      sizeBytes: row.sizeBytes,
      url: await this.store.presignGet(row.storageKey, BRAND_IMAGE_URL_TTL_SECONDS),
    };
  }

  /**
   * What Autopilot applies to a run's clips: the saved kit and its logo, or
   * `null` when the workspace has never saved one — which is what keeps a
   * workspace without a kit on exactly today's clips.
   */
  async forClips(workspaceId: string): Promise<KitForClips | null> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      include: { logoAsset: true, musicAsset: true },
    });
    if (kit === null) return null;
    const logo = kit.logoAsset === null ? undefined : overlayImageOf(kit.logoAsset);
    const music = kit.musicAsset === null ? undefined : musicTrackOf(kit.musicAsset);
    return {
      settings: brandKitSettingsOf(kit.doc),
      ...(logo === undefined ? {} : { logo }),
      ...(music === undefined ? {} : { music }),
    };
  }

  // -------------------------------------------------------------------------
  // Music (2026-10-04)
  // -------------------------------------------------------------------------

  /**
   * `POST /brand-kit/music`: a presigned PUT for the kit's own track. The
   * rights confirmation is asked for here too, so nothing is uploaded without
   * it; it is recorded on `complete`.
   *
   * @throws AppException 400 `brand_kit/music_rights_required`, 413
   *   `brand_kit/music_too_large`.
   */
  async createMusicUpload(
    workspaceId: string,
    input: MusicUploadInput,
  ): Promise<MusicUploadTicket> {
    if (!input.rightsAttested) throw musicRightsRequired();
    if (input.sizeBytes > MUSIC_MAX_BYTES) throw musicTooLarge(input.sizeBytes);
    const assetId = ulid();
    const key = brandAssetKey(
      workspaceId,
      assetId,
      MUSIC_CONTENT_TYPES[input.contentType].extension,
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
      maxBytes: MUSIC_MAX_BYTES,
    };
  }

  /**
   * `POST /brand-kit/music/{assetId}/complete`: checks the uploaded track and
   * makes it the kit's (creating the kit with its defaults if there is none),
   * recording who confirmed the rights to use it, and when. A file that is not
   * the MP3, WAV or M4A it claims, too large, too short or too long is deleted
   * and refused. Idempotent.
   *
   * @returns the kit, and the track it replaced (null for none).
   */
  async completeMusic(
    workspaceId: string,
    userId: string | null,
    assetId: string,
    input: MusicCompleteInput,
  ): Promise<{ readonly view: BrandKitView; readonly replaced: string | null }> {
    if (!input.rightsAttested) throw musicRightsRequired();
    if (!ULID_PATTERN.test(assetId)) throw musicNotFound();
    const existing = await this.prisma.brandAsset.findUnique({ where: { id: assetId } });
    if (existing !== null) {
      if (existing.workspaceId !== workspaceId || existing.kind !== MUSIC_ASSET_KIND) {
        throw musicNotFound();
      }
      const replaced = await this.pointKitMusicAt(workspaceId, assetId);
      return { view: await this.view(workspaceId), replaced };
    }

    const type = MUSIC_CONTENT_TYPES[input.contentType];
    const key = brandAssetKey(workspaceId, assetId, type.extension);
    const head = await this.store.head(key);
    if (head === null) {
      throw new AppException(
        BRAND_KIT_ERROR_CODES.musicNotUploaded,
        "The music has not finished uploading. Try again in a moment.",
        HttpStatus.CONFLICT,
      );
    }
    if (head.sizeBytes > MUSIC_MAX_BYTES) {
      await this.discard(key);
      throw musicTooLarge(head.sizeBytes);
    }
    const bytes = new Uint8Array(await this.store.get(key));
    if (bytes.byteLength > MUSIC_MAX_BYTES) {
      await this.discard(key);
      throw musicTooLarge(bytes.byteLength);
    }
    const facts = probeAudio(bytes);
    if (facts === undefined || facts.format !== type.format) {
      await this.discard(key);
      throw new AppException(
        BRAND_KIT_ERROR_CODES.musicInvalid,
        "That file is not an MP3, WAV or M4A audio file.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (facts.durationMs < MUSIC_MIN_DURATION_MS || facts.durationMs > MUSIC_MAX_DURATION_MS) {
      await this.discard(key);
      throw new AppException(
        BRAND_KIT_ERROR_CODES.musicBadLength,
        `Music must be between ${String(MUSIC_MIN_DURATION_MS / 1000)} seconds and ${String(MUSIC_MAX_DURATION_MS / 60_000)} minutes long.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          durationMs: facts.durationMs,
          minDurationMs: MUSIC_MIN_DURATION_MS,
          maxDurationMs: MUSIC_MAX_DURATION_MS,
        },
      );
    }

    const title = input.title?.trim();
    await this.prisma.brandAsset.create({
      data: {
        id: assetId,
        workspaceId,
        kind: MUSIC_ASSET_KIND,
        storageKey: key,
        contentType: input.contentType,
        sizeBytes: bytes.byteLength,
        durationMs: facts.durationMs,
        title: title === undefined || title === "" ? null : title,
        rightsAttestedAt: new Date(),
        rightsAttestedBy: userId,
        createdBy: userId,
      },
    });
    const replaced = await this.pointKitMusicAt(workspaceId, assetId);
    await this.collectUnusedMusic(workspaceId);
    return { view: await this.view(workspaceId), replaced };
  }

  /**
   * `DELETE /brand-kit/music`: the kit stops laying its music under new clips.
   * Clips whose bed names the track keep it; a track nothing names is
   * deleted. Idempotent.
   */
  async removeMusic(
    workspaceId: string,
  ): Promise<{ readonly view: BrandKitView; readonly removed: string | null }> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      select: { id: true, musicAssetId: true },
    });
    const removed = kit?.musicAssetId ?? null;
    if (kit !== null && removed !== null) {
      await this.prisma.brandKit.update({ where: { id: kit.id }, data: { musicAssetId: null } });
    }
    await this.collectUnusedMusic(workspaceId);
    return { view: await this.view(workspaceId), removed };
  }

  /**
   * The objects of the workspace's tracks among `assetIds`, by asset id: what a
   * render reads a workspace bed from. Another workspace's track, or one that
   * is gone, is not there, and its bed is left out of the render.
   */
  async musicStorageKeys(
    workspaceId: string,
    assetIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(assetIds)].filter((id) => ULID_PATTERN.test(id));
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.brandAsset.findMany({
      where: { workspaceId, kind: MUSIC_ASSET_KIND, id: { in: ids } },
      select: { id: true, storageKey: true },
    });
    return new Map(rows.map((row) => [row.id, row.storageKey]));
  }

  /**
   * Deletes every track of the workspace that nothing plays any more: not the
   * kit's, and named by no clip's bed (`edg_pass_items`). Best effort, object
   * then row, like the logos; looked at again on the next change.
   */
  async collectUnusedMusic(workspaceId: string): Promise<number> {
    let deleted = 0;
    try {
      const kit = await this.prisma.brandKit.findUnique({
        where: { workspaceId },
        select: { musicAssetId: true },
      });
      const tracks = await this.prisma.brandAsset.findMany({
        where: { workspaceId, kind: MUSIC_ASSET_KIND },
        select: { id: true, storageKey: true },
      });
      for (const track of tracks) {
        if (track.id === kit?.musicAssetId) continue;
        if (await this.bedsName(workspaceId, track.id)) continue;
        await this.store.delete(track.storageKey);
        await this.prisma.brandAsset.delete({ where: { id: track.id } });
        deleted += 1;
      }
    } catch (error) {
      this.logger.warn(
        { workspaceId, err: error },
        "could not tidy the workspace's unused music; it is looked at again on the next change",
      );
    }
    return deleted;
  }

  /** Makes `assetId` the kit's music, creating the kit if there is none. Returns the track it replaced. */
  private async pointKitMusicAt(workspaceId: string, assetId: string): Promise<string | null> {
    const kit = await this.prisma.brandKit.findUnique({
      where: { workspaceId },
      select: { id: true, musicAssetId: true },
    });
    if (kit === null) {
      await this.upsertKit(
        workspaceId,
        { doc: { v: BRAND_KIT_VERSION, ...DEFAULT_BRAND_KIT_SETTINGS }, musicAssetId: assetId },
        { musicAssetId: assetId },
      );
      return null;
    }
    if (kit.musicAssetId === assetId) return null;
    await this.prisma.brandKit.update({ where: { id: kit.id }, data: { musicAssetId: assetId } });
    return kit.musicAssetId;
  }

  /**
   * Whether any clip's bed in the workspace names the track - in any state, so
   * a bed a person took off a clip can still be put back. `assetId` is a
   * checked ULID; the query is parameterised all the same.
   */
  private async bedsName(workspaceId: string, assetId: string): Promise<boolean> {
    if (!ULID_PATTERN.test(assetId)) return true;
    const rows = await this.prisma.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found
        FROM edg_pass_items i
        JOIN edg_documents d ON d.id = i.edg_id
        JOIN projects p ON p.id = d.project_id
       WHERE p.workspace_id = ${workspaceId}
         AND i.kind = 'music'
         AND i.payload ->> 'assetId' = ${assetId}
       LIMIT 1`;
    return rows.length > 0;
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
    create: {
      readonly doc: Prisma.InputJsonValue;
      readonly logoAssetId?: string;
      readonly musicAssetId?: string;
    },
    update: {
      readonly doc?: Prisma.InputJsonValue;
      readonly logoAssetId?: string;
      readonly musicAssetId?: string;
    },
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

  /**
   * Reads back an uploaded image - at most `rules.maxBytes` - and keeps it only
   * if it opens as `format` at a usable size; otherwise deletes it and throws
   * the rules' refusal. The logo and a run's cover share this.
   */
  private async checkUploadedImage(
    key: string,
    format: LogoFormat,
    rules: ImageRules,
  ): Promise<{ readonly facts: ImageFacts; readonly sizeBytes: number }> {
    const head = await this.store.head(key);
    if (head === null) throw rules.notUploaded();
    if (head.sizeBytes > rules.maxBytes) {
      await this.discard(key);
      throw rules.tooLarge(head.sizeBytes);
    }
    const bytes = new Uint8Array(await this.store.get(key));
    if (bytes.byteLength > rules.maxBytes) {
      await this.discard(key);
      throw rules.tooLarge(bytes.byteLength);
    }
    const facts = probeImage(bytes);
    if (facts === undefined || facts.format !== format) {
      await this.discard(key);
      throw rules.invalid();
    }
    const sides = [facts.width, facts.height];
    if (sides.some((side) => side < rules.minSide || side > rules.maxSide)) {
      await this.discard(key);
      throw rules.badSize(facts);
    }
    return { facts, sizeBytes: bytes.byteLength };
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

/** A stored track as the settings page shows it. */
function musicView(asset: BrandAsset, url: string): BrandKitMusicView {
  const contentType = (
    Object.hasOwn(MUSIC_CONTENT_TYPES, asset.contentType) ? asset.contentType : "audio/mpeg"
  ) as MusicContentType;
  return {
    assetId: asset.id,
    // eslint-disable-next-line security/detect-object-injection -- a closed enum, checked against the table above
    format: MUSIC_CONTENT_TYPES[contentType].format,
    contentType,
    durationMs: asset.durationMs ?? 0,
    sizeBytes: asset.sizeBytes,
    title: asset.title,
    url,
    rightsAttestedAt: asset.rightsAttestedAt?.toISOString() ?? null,
    rightsAttestedBy: asset.rightsAttestedBy,
  };
}

/** A stored track as a bed names it; `undefined` for a row with no rights recorded. */
export function musicTrackOf(asset: BrandAsset): BrandMusicTrack | undefined {
  if (asset.rightsAttestedAt === null) return undefined;
  return {
    assetId: asset.id,
    rightsAttestedAt: asset.rightsAttestedAt.toISOString(),
    rightsAttestedBy: asset.rightsAttestedBy,
    ...(asset.title === null ? {} : { title: asset.title }),
  };
}

function musicTooLarge(sizeBytes: number): AppException {
  return new AppException(
    BRAND_KIT_ERROR_CODES.musicTooLarge,
    `Music can be at most ${String(MUSIC_MAX_BYTES / (1024 * 1024))} MB.`,
    HttpStatus.PAYLOAD_TOO_LARGE,
    { sizeBytes, maxBytes: MUSIC_MAX_BYTES },
  );
}

function musicRightsRequired(): AppException {
  return new AppException(
    BRAND_KIT_ERROR_CODES.musicRightsRequired,
    "Confirm that you have the rights to use this music.",
    HttpStatus.BAD_REQUEST,
  );
}

function musicNotFound(): AppException {
  return new AppException(
    BRAND_KIT_ERROR_CODES.musicNotFound,
    "No such music upload.",
    HttpStatus.NOT_FOUND,
  );
}

/** An image a worker reads from the derived store: an audiogram's artwork (2026-10-04). */
export interface ArtworkObject {
  readonly key: string;
  readonly format: LogoFormat;
}

/** The format a stored image was uploaded as, from its content type. */
function formatOfContentType(contentType: string): LogoFormat | undefined {
  return Object.hasOwn(LOGO_CONTENT_TYPES, contentType)
    ? LOGO_CONTENT_TYPES[contentType as LogoContentType].format
    : undefined;
}

/** What an uploaded image is held to, and how each refusal is worded. */
interface ImageRules {
  readonly maxBytes: number;
  readonly minSide: number;
  readonly maxSide: number;
  readonly notUploaded: () => AppException;
  readonly tooLarge: (sizeBytes: number) => AppException;
  readonly invalid: () => AppException;
  readonly badSize: (facts: ImageFacts) => AppException;
}

const LOGO_RULES: ImageRules = {
  maxBytes: LOGO_MAX_BYTES,
  minSide: LOGO_MIN_SIDE,
  maxSide: LOGO_MAX_SIDE,
  notUploaded: () =>
    new AppException(
      BRAND_KIT_ERROR_CODES.logoNotUploaded,
      "The logo has not finished uploading. Try again in a moment.",
      HttpStatus.CONFLICT,
    ),
  tooLarge,
  invalid: () =>
    new AppException(
      BRAND_KIT_ERROR_CODES.logoInvalid,
      "That file is not a PNG, JPEG or WebP image.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    ),
  badSize: (facts) =>
    new AppException(
      BRAND_KIT_ERROR_CODES.logoBadSize,
      `A logo must be between ${String(LOGO_MIN_SIDE)} and ${String(LOGO_MAX_SIDE)} pixels on each side; this one is ${String(facts.width)} × ${String(facts.height)}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { width: facts.width, height: facts.height },
    ),
};

/** A run's cover (2026-10-04): larger than a logo may be, and never tiny. */
const COVER_RULES: ImageRules = {
  maxBytes: COVER_MAX_BYTES,
  minSide: COVER_MIN_SIDE,
  maxSide: COVER_MAX_SIDE,
  notUploaded: () =>
    new AppException(
      COVER_ERROR_CODES.notUploaded,
      "The cover has not finished uploading. Try again in a moment.",
      HttpStatus.CONFLICT,
    ),
  tooLarge: (sizeBytes) =>
    new AppException(
      COVER_ERROR_CODES.tooLarge,
      `A cover can be at most ${String(COVER_MAX_BYTES / (1024 * 1024))} MB.`,
      HttpStatus.PAYLOAD_TOO_LARGE,
      { sizeBytes, maxBytes: COVER_MAX_BYTES },
    ),
  invalid: () =>
    new AppException(
      COVER_ERROR_CODES.invalid,
      "That file is not a PNG, JPEG or WebP image.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    ),
  badSize: (facts) =>
    new AppException(
      COVER_ERROR_CODES.badSize,
      `A cover must be between ${String(COVER_MIN_SIDE)} and ${String(COVER_MAX_SIDE)} pixels on each side; this one is ${String(facts.width)} × ${String(facts.height)}.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { width: facts.width, height: facts.height },
    ),
};

function coverNotFound(): AppException {
  return new AppException(COVER_ERROR_CODES.notFound, "No such cover.", HttpStatus.NOT_FOUND);
}

function logoNotFound(): AppException {
  return new AppException(
    BRAND_KIT_ERROR_CODES.logoNotFound,
    "No such logo upload.",
    HttpStatus.NOT_FOUND,
  );
}
