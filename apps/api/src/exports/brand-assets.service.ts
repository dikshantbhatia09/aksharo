import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import type { WatermarkPosition } from "@montaj/render-manifest";

import { BRAND_ASSET_UPLOAD_URL_TTL_SECONDS, PNG_MAGIC_BYTES } from "./exports.constants.js";
import { EXPORT_ERROR_CODES } from "./exports.errors.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { brandAssetKey, DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";

import type { BrandAsset } from "@prisma/client";

/**
 * A workspace's own watermark/logo image (CONTRACTS §6:
 * `ws/{workspaceId}/brand/{assetId}.png`), used two ways:
 *
 * - the export dialog offers it as a deliberate overlay on an otherwise
 *   unwatermarked (paid-plan) export — `ExportsService` reads it when the
 *   request carries `options.brandAssetId`;
 * - it never substitutes for the Free-tier anti-piracy mark, which is the
 *   platform's own bundled asset (`manifest-builder.ts`), not a row here.
 *
 * Bytes go straight to R2 through a presigned PUT — a watermark PNG is a few
 * kilobytes, so this skips the multipart machinery `media/**` needs for a
 * two-hour recording. `contentType` is set on the signed URL itself, which S3
 * enforces on the PUT; nothing this small needs a second server round trip to
 * confirm the upload landed before the row is usable.
 */
@Injectable()
export class BrandAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
  ) {}

  async create(
    workspaceId: string,
    userId: string | null,
    input: { contentType: string; sizeBytes: number },
  ): Promise<{ asset: BrandAsset; uploadUrl: string; expiresAt: string }> {
    const id = ulid();
    const key = brandAssetKey(workspaceId, id);
    const uploadUrl = await this.store.presignPut(
      key,
      BRAND_ASSET_UPLOAD_URL_TTL_SECONDS,
      input.contentType,
    );

    const asset = await this.prisma.brandAsset.create({
      data: {
        id,
        workspaceId,
        kind: "watermark",
        storageKey: key,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        createdBy: userId,
      },
    });

    return {
      asset,
      uploadUrl,
      expiresAt: new Date(Date.now() + BRAND_ASSET_UPLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
    };
  }

  async list(workspaceId: string): Promise<BrandAsset[]> {
    return this.prisma.brandAsset.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }

  async delete(workspaceId: string, assetId: string): Promise<void> {
    const asset = await this.prisma.brandAsset.findFirst({ where: { id: assetId, workspaceId } });
    if (asset === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.brandAssetNotFound,
        "No such brand asset.",
        HttpStatus.NOT_FOUND,
      );
    }
    await this.store.delete(asset.storageKey);
    await this.prisma.brandAsset.delete({ where: { id: assetId } });
  }

  /**
   * Resolve a request's `options.brandAssetId` into the manifest's `watermark`
   * shape, or throw when it does not belong to the caller's workspace.
   */
  async resolveForWatermark(
    workspaceId: string,
    assetId: string,
    position: WatermarkPosition,
    opacity: number,
  ): Promise<{ assetId: string; position: WatermarkPosition; opacity: number }> {
    const asset = await this.prisma.brandAsset.findFirst({ where: { id: assetId, workspaceId } });
    if (asset === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.brandAssetNotFound,
        "No such brand asset.",
        HttpStatus.NOT_FOUND,
      );
    }
    return { assetId: asset.id, position, opacity };
  }
}

/** True when `bytes` opens with the PNG magic number. Callers with real bytes only (tests). */
export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC_BYTES.length) return false;
  return PNG_MAGIC_BYTES.every((byte, index) => bytes[index] === byte);
}
