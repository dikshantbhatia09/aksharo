import { Body, Controller, HttpStatus, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";

import { InternalSignatureGuard } from "./internal-signature.guard.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { mediaPrefix } from "../common/storage/storage.keys.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";
import { MEDIA_FAILURE_REASONS } from "../media/media.constants.js";

import type { Prisma } from "@prisma/client";

/** Longest object key any store here will accept. */
const MAX_KEY_LENGTH = 1_024;

/**
 * How many thumbnails one asset may carry.
 *
 * A07 writes ten evenly spaced frames plus a poster; the cap is generous enough
 * for a later change of mind and small enough that no worker can turn an array
 * column into storage.
 */
const MAX_THUMB_KEYS = 32;

const objectKey = z.string().min(1).max(MAX_KEY_LENGTH);

/**
 * What a media worker is allowed to write back.
 *
 * An **allow-list**, not a partial of the row: `media.probe` and `media.proxy`
 * report technical facts about the bytes and the derived artefacts they produced,
 * and nothing else. Ownership (`projectId`), storage location (`storageKey`,
 * `bucket`) and retention (`rawPurgeAt`, `derivedPurgeAt`) are the API's to set,
 * so a compromised worker cannot repoint an asset at another tenant's object
 * (THREAT-MODEL T5) or extend its own retention.
 *
 * Two of the fields need more than a type to be safe:
 *
 * - **the derived keys** are paths, and a path is exactly what T5 is about. Being
 *   on the allow-list only says a worker may set `proxyKey`; {@link assertOwnKeys}
 *   is what says it may only set it to an object under *this* asset's own prefix.
 *   Without that, `proxyKey` is `storageKey` with an extra step.
 * - **`failureReason`** is rendered to the user, so it is a closed set of
 *   `media/*` codes (`MEDIA_FAILURE_REASONS`) rather than a worker-supplied
 *   sentence.
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
    /** Video codec name from `ffprobe`, e.g. `h264`; absent for audio-only. */
    codec: z.string().min(1).max(64).optional(),
    /** Whether the container carries a usable audio stream. */
    hasAudio: z.boolean().optional(),
    /** PQ or HLG source; the proxy is tone-mapped to BT.709 either way. */
    hdr: z.boolean().optional(),
    /** Only meaningful next to `status: "failed"`; see {@link MEDIA_FAILURE_REASONS}. */
    failureReason: z.enum(MEDIA_FAILURE_REASONS).optional(),
    proxyKey: objectKey.optional(),
    audio16kKey: objectKey.optional(),
    audio48kKey: objectKey.optional(),
    waveformKey: objectKey.optional(),
    /** `thumb-{n}.jpg` keys in index order (CONTRACTS §6). */
    thumbKeys: z.array(objectKey).max(MAX_THUMB_KEYS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update." });

export class MediaPatchDto extends zodDto(MediaPatchSchema) {}

export interface MediaPatchAck {
  readonly mediaId: string;
  readonly status: string;
}

/** The derived-key fields, so the prefix check cannot miss one that is added later. */
const DERIVED_KEY_FIELDS = ["proxyKey", "audio16kKey", "audio48kKey", "waveformKey"] as const;

/**
 * `PATCH /internal/media/{id}` — the media worker's write-back path.
 *
 * A08 owns it because A08 owns the signed internal surface; A06/A07 own the media
 * *domain*. A07 widened the allow-list to everything `media.probe` and
 * `media.proxy` measure, and added the prefix check that keeps a derived key
 * inside the asset it belongs to.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/media")
export class InternalMediaController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch(":id")
  async patch(@Param("id") id: string, @Body() body: MediaPatchDto): Promise<MediaPatchAck> {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id },
      select: { id: true, projectId: true, project: { select: { workspaceId: true } } },
    });
    if (asset === null) {
      throw new AppException(ERROR_CODES.notFound, "No such media asset.", HttpStatus.NOT_FOUND, {
        mediaId: id,
      });
    }

    assertOwnKeys(body, mediaPrefix(asset.project.workspaceId, asset.projectId, asset.id));

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

    const updated = await this.prisma.mediaAsset.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return { mediaId: id, status: updated.status };
  }
}

/**
 * Every key in the patch must name an object under this asset's own prefix.
 *
 * The prefix is rebuilt from the row — the workspace, project and media ids the
 * API holds — never from anything in the body, so the check cannot be satisfied by
 * a worker that simply asserts a different tenant (THREAT-MODEL T5). A worker with
 * a stolen callback secret can still write nonsense about its own asset; it cannot
 * make that asset point at somebody else's footage.
 *
 * @throws AppException 400 naming only the field, never the offending key.
 */
export function assertOwnKeys(
  body: Partial<Record<(typeof DERIVED_KEY_FIELDS)[number] | "thumbKeys", unknown>>,
  prefix: string,
): void {
  const scope = `${prefix}/`;
  const offending: string[] = [];

  for (const field of DERIVED_KEY_FIELDS) {
    const value = body[field];
    if (typeof value === "string" && !isInside(value, scope)) offending.push(field);
  }
  const thumbs = body.thumbKeys;
  if (Array.isArray(thumbs) && thumbs.some((key) => !isInside(String(key), scope))) {
    offending.push("thumbKeys");
  }

  if (offending.length === 0) return;
  throw new AppException(
    ERROR_CODES.validationFailed,
    "A derived key must name an object belonging to this media asset.",
    HttpStatus.BAD_REQUEST,
    { fields: offending },
  );
}

/** Inside the prefix, and with no traversal that could climb back out of it. */
function isInside(key: string, scope: string): boolean {
  return key.startsWith(scope) && !key.includes("..");
}
