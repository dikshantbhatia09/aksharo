/**
 * The B-roll library's limits and codes (2026-10-05). Deployment-tunable
 * numbers, not CONTRACTS §1 secrets.
 */

import type { RateLimitRule } from "../common/guards/index.js";

/**
 * The largest picture the library keeps: the render decodes each cutaway on
 * every rasteriser (`apps/render` `OVERLAY_IMAGE_MAX_BYTES` is the same 8 MB).
 * The web app shrinks a photo to {@link BROLL_UPLOAD_LONG_SIDE} before it
 * uploads it, so a phone's 12 MB photo arrives at a few hundred kilobytes.
 */
export const BROLL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The smallest and the largest side a picture may have, in pixels. Smaller
 * than 320 is a thumbnail blown up six times on a 1080 frame; larger than
 * 3840 costs a render memory for detail no clip shows.
 */
export const BROLL_MIN_SIDE = 320;
export const BROLL_MAX_SIDE = 3840;

/** The long side the web app shrinks a photo to before uploading it. */
export const BROLL_UPLOAD_LONG_SIDE = 2560;

/** The most pictures one workspace's library keeps. */
export const BROLL_MAX_ASSETS = 300;

/** The most tags on one picture, and the longest tag. */
export const BROLL_MAX_TAGS = 10;
export const BROLL_TAG_MAX = 40;

/** The longest title kept for a picture (its file's name, or a stock photo's description). */
export const BROLL_TITLE_MAX = 120;

/** What a picture may be, and the format and file extension each is stored as. */
export const BROLL_CONTENT_TYPES = {
  "image/png": { format: "png", extension: "png" },
  "image/jpeg": { format: "jpeg", extension: "jpg" },
  "image/webp": { format: "webp", extension: "webp" },
} as const;

export type BrollContentType = keyof typeof BROLL_CONTENT_TYPES;
export type BrollFormat = (typeof BROLL_CONTENT_TYPES)[BrollContentType]["format"];

export const BROLL_CONTENT_TYPE_LIST = Object.keys(BROLL_CONTENT_TYPES) as BrollContentType[];

/** How long the browser has to PUT a picture. */
export const BROLL_UPLOAD_URL_TTL_SECONDS = 10 * 60;

/**
 * How long a picture's signed URL lasts: the library page and the editor hold
 * one for their whole session (`useBrollLibrary` refetches well inside it).
 */
export const BROLL_IMAGE_URL_TTL_SECONDS = 60 * 60;

/** Where a picture came from (`broll_assets.source`). */
export const BROLL_SOURCES = ["upload", "pexels"] as const;
export type BrollSource = (typeof BROLL_SOURCES)[number];

/** A stock search's page: enough to choose from, few enough to show at once. */
export const STOCK_SEARCH_PER_PAGE = 24;

/** The longest search a person may type, and the fewest characters worth searching for. */
export const STOCK_QUERY_MAX = 80;
export const STOCK_QUERY_MIN = 2;

/** A saved stock photo's long side: asked of the photo service, then checked. */
export const STOCK_SAVE_LONG_SIDE = 2560;

/** Error codes (CONTRACTS §8: `namespace/slug`). */
export const BROLL_ERROR_CODES = {
  /** Not a PNG, JPEG or WebP, or its declared type does not match its bytes. */
  invalid: "broll/picture_invalid",
  /** Over {@link BROLL_MAX_BYTES}. */
  tooLarge: "broll/picture_too_large",
  /** Smaller or larger than a cutaway can use. */
  badSize: "broll/picture_bad_size",
  /** `complete` before the bytes arrived. */
  notUploaded: "broll/picture_not_uploaded",
  /** The id names no picture of this workspace's. */
  notFound: "broll/picture_not_found",
  /** The library already keeps {@link BROLL_MAX_ASSETS} pictures. */
  libraryFull: "broll/library_full",
  /** Stock photos are not set up here (no `PEXELS_API_KEY`). */
  stockDisabled: "broll/stock_disabled",
  /** The photo service's hourly allowance is spent; try again later. */
  stockBusy: "broll/stock_busy",
  /** The photo service did not answer usably. */
  stockUnavailable: "broll/stock_unavailable",
  /** The photo service has no such photo. */
  stockNotFound: "broll/stock_not_found",
} as const;

/**
 * Per user: uploads (a batch of pictures, and room to redo them), stock
 * searches (one per word typed would be too many; the page waits for a pause)
 * and stock saves. The photo service's own hourly allowance is shared by the
 * whole deployment besides (`PexelsBudget`).
 */
export const BROLL_RATE_LIMITS = {
  upload: {
    name: "broll:upload:user",
    by: "user",
    capacity: 120,
    refillPerSec: 120 / 3600,
  },
  stockSearch: {
    name: "broll:stock-search:user",
    by: "user",
    capacity: 40,
    refillPerSec: 40 / 3600,
  },
  stockSave: {
    name: "broll:stock-save:user",
    by: "user",
    capacity: 60,
    refillPerSec: 60 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;
