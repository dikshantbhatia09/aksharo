import { z } from "zod";

import {
  BROLL_CONTENT_TYPE_LIST,
  BROLL_MAX_TAGS,
  BROLL_TAG_MAX,
  BROLL_TITLE_MAX,
  STOCK_QUERY_MAX,
  STOCK_QUERY_MIN,
  type BrollContentType,
} from "./broll.constants.js";
import { zodDto } from "../common/index.js";

/**
 * Request bodies and answers for the B-roll library (2026-10-05). A tag is
 * trimmed and lower-cased by the service; here it is only bounded.
 */

const contentType = z.enum(BROLL_CONTENT_TYPE_LIST as [BrollContentType, ...BrollContentType[]]);

const tags = z.array(z.string().trim().min(1).max(BROLL_TAG_MAX)).max(BROLL_MAX_TAGS);

const title = z.string().trim().max(BROLL_TITLE_MAX);

/** `POST /broll/uploads`: what is about to be uploaded. The size is checked, then trusted no further. */
export const brollUploadSchema = z
  .object({
    contentType,
    sizeBytes: z.number().int().min(1),
  })
  .strict();
export class BrollUploadDto extends zodDto(brollUploadSchema) {}

/** `POST /broll/{assetId}/complete`: the type it was signed for, and what it shows. */
export const brollCompleteSchema = z
  .object({
    contentType,
    tags: tags.optional(),
    /** The file's name without its extension, or what the person typed; display only. */
    title: title.optional(),
  })
  .strict();
export class BrollCompleteDto extends zodDto(brollCompleteSchema) {}

/** `PATCH /broll/{assetId}`: new tags, a new title, or both. */
export const brollUpdateSchema = z
  .object({
    tags: tags.optional(),
    title: title.optional(),
  })
  .strict()
  .refine((value) => value.tags !== undefined || value.title !== undefined, {
    message: "Say which tags or title to change.",
  });
export class BrollUpdateDto extends zodDto(brollUpdateSchema) {}

/** `GET /broll/stock`: what to look for, and the shape the clip is (its orientation). */
export const stockSearchSchema = z
  .object({
    query: z.string().trim().min(STOCK_QUERY_MIN).max(STOCK_QUERY_MAX),
    orientation: z.enum(["portrait", "landscape", "square"]).optional(),
    page: z.coerce.number().int().min(1).max(20).default(1),
  })
  .strict();
export class StockSearchDto extends zodDto(stockSearchSchema) {}

/**
 * `POST /broll/stock`: the photo to keep, by its id at the photo service. The
 * server reads the photo from the service itself, so no address a person sends
 * is ever fetched.
 */
export const stockSaveSchema = z
  .object({
    photoId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    tags: tags.optional(),
  })
  .strict();
export class StockSaveDto extends zodDto(stockSaveSchema) {}

/** A stock photo's credit: kept though not required by its licence. */
export const brollCreditSchema = z.object({
  provider: z.literal("pexels"),
  photographer: z.string(),
  photographerUrl: z.string(),
  pageUrl: z.string(),
});

/** One picture of the library. */
export const brollItemViewSchema = z.object({
  assetId: z.string(),
  format: z.enum(["png", "jpeg", "webp"]),
  contentType,
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.number().int(),
  tags: z.array(z.string()),
  title: z.string().nullable(),
  source: z.enum(["upload", "pexels"]),
  credit: brollCreditSchema.nullable(),
  /** Signed for an hour: the library page and the editor draw it from here. */
  url: z.string(),
  createdAt: z.string(),
});

export const brollLibraryViewSchema = z.object({
  /** Newest first. */
  items: z.array(brollItemViewSchema),
  /** Whether stock photos can be searched and saved here (`PEXELS_API_KEY`). */
  stock: z.object({
    enabled: z.boolean(),
    provider: z.literal("pexels").nullable(),
  }),
  limits: z.object({
    maxBytes: z.number().int(),
    contentTypes: z.array(z.string()),
    minSide: z.number().int(),
    maxSide: z.number().int(),
    /** The long side the web app shrinks a photo to before it uploads it. */
    uploadLongSide: z.number().int(),
    maxAssets: z.number().int(),
    maxTags: z.number().int(),
    tagMax: z.number().int(),
    titleMax: z.number().int(),
  }),
});

export const brollUploadTicketSchema = z.object({
  assetId: z.string(),
  /** PUT the bytes here, with this `Content-Type`. */
  uploadUrl: z.string(),
  contentType,
  expiresAt: z.string(),
  maxBytes: z.number().int(),
});

export const brollDeletedSchema = z.object({
  /** False when there was no such picture (already gone, or another workspace's). */
  deleted: z.boolean(),
});

/** One photo a stock search found. */
export const stockPhotoViewSchema = z.object({
  id: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  /** The service's description of it; empty when it has none. */
  alt: z.string(),
  photographer: z.string(),
  photographerUrl: z.string(),
  /** The photo's page at the service. */
  pageUrl: z.string(),
  /** About 350 px high, for a results grid. */
  previewUrl: z.string(),
});

export const stockSearchViewSchema = z.object({
  provider: z.literal("pexels"),
  query: z.string(),
  page: z.number().int(),
  photos: z.array(stockPhotoViewSchema),
});

export type BrollUploadInput = z.infer<typeof brollUploadSchema>;
export type BrollCompleteInput = z.infer<typeof brollCompleteSchema>;
export type BrollUpdateInput = z.infer<typeof brollUpdateSchema>;
export type StockSearchInput = z.infer<typeof stockSearchSchema>;
export type StockSaveInput = z.infer<typeof stockSaveSchema>;
export type BrollCredit = z.infer<typeof brollCreditSchema>;
export type BrollItemView = z.infer<typeof brollItemViewSchema>;
export type BrollLibraryView = z.infer<typeof brollLibraryViewSchema>;
export type BrollUploadTicket = z.infer<typeof brollUploadTicketSchema>;
export type StockPhotoView = z.infer<typeof stockPhotoViewSchema>;
export type StockSearchView = z.infer<typeof stockSearchViewSchema>;
