import { Body, Controller, HttpStatus, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";

import { InternalSignatureGuard } from "./internal-signature.guard.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

import type { Prisma } from "@prisma/client";

/**
 * What a media worker is allowed to write back.
 *
 * An **allow-list**, not a partial of the row: `media.probe` and `media.proxy`
 * report technical facts about the bytes and the derived artefacts they produced,
 * and nothing else. Ownership (`projectId`), storage location (`storageKey`,
 * `bucket`) and retention (`rawPurgeAt`, `derivedPurgeAt`) are the API's to set,
 * so a compromised worker cannot repoint an asset at another tenant's object
 * (THREAT-MODEL T5) or extend its own retention.
 */
const MediaPatchSchema = z
  .object({
    status: z.enum(["uploaded", "probing", "ready", "failed"]).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    contentHash: z.string().min(1).max(128).optional(),
    mime: z.string().min(1).max(255).optional(),
    durationMs: z.number().int().min(0).optional(),
    fps: z.number().min(0).max(1_000).optional(),
    width: z.number().int().min(0).max(65_535).optional(),
    height: z.number().int().min(0).max(65_535).optional(),
    audioChannels: z.number().int().min(0).max(64).optional(),
    proxyKey: z.string().min(1).max(1_024).optional(),
    audio16kKey: z.string().min(1).max(1_024).optional(),
    audio48kKey: z.string().min(1).max(1_024).optional(),
    waveformKey: z.string().min(1).max(1_024).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update." });

export class MediaPatchDto extends zodDto(MediaPatchSchema) {}

export interface MediaPatchAck {
  readonly mediaId: string;
  readonly status: string;
}

/**
 * `PATCH /internal/media/{id}` — the media worker's write-back path.
 *
 * A08 owns it because A08 owns the signed internal surface; A06/A07 own the media
 * *domain*. If A07 lands its own copy, this one is deleted and the guard is what
 * survives.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/media")
export class InternalMediaController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch(":id")
  async patch(@Param("id") id: string, @Body() body: MediaPatchDto): Promise<MediaPatchAck> {
    const data: Prisma.MediaAssetUncheckedUpdateInput = {
      ...body,
      ...(body.sizeBytes === undefined ? {} : { sizeBytes: BigInt(body.sizeBytes) }),
    };

    const { count } = await this.prisma.mediaAsset.updateMany({ where: { id }, data });
    if (count === 0) {
      throw new AppException(ERROR_CODES.notFound, "No such media asset.", HttpStatus.NOT_FOUND, {
        mediaId: id,
      });
    }

    const asset = await this.prisma.mediaAsset.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return { mediaId: id, status: asset.status };
  }
}
