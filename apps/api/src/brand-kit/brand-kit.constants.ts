/**
 * The brand kit's limits and codes (2026-10-02). Deployment-tunable numbers,
 * not CONTRACTS §1 secrets.
 */

import type { RateLimitRule } from "../common/guards/index.js";

/** The largest logo a kit takes: a mark is kilobytes, and a render decodes it on every worker. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** The smallest and largest side a logo may have, in pixels. */
export const LOGO_MIN_SIDE = 16;
export const LOGO_MAX_SIDE = 4096;

/** What a logo may be, and the format and file extension each is stored as. */
export const LOGO_CONTENT_TYPES = {
  "image/png": { format: "png", extension: "png" },
  "image/jpeg": { format: "jpeg", extension: "jpg" },
  "image/webp": { format: "webp", extension: "webp" },
} as const;

export type LogoContentType = keyof typeof LOGO_CONTENT_TYPES;
export type LogoFormat = (typeof LOGO_CONTENT_TYPES)[LogoContentType]["format"];

export const LOGO_CONTENT_TYPE_LIST = Object.keys(LOGO_CONTENT_TYPES) as LogoContentType[];

/** The content type a stored logo of `format` was uploaded as. */
export function contentTypeOfFormat(format: LogoFormat): LogoContentType {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}

/** How long the browser has to PUT a logo. */
export const LOGO_UPLOAD_URL_TTL_SECONDS = 10 * 60;

/**
 * How long a logo's signed URL lasts: the editor and a run's clip previews hold
 * one for their whole session (`useBrandKit` refetches well inside it).
 */
export const BRAND_IMAGE_URL_TTL_SECONDS = 60 * 60;

/** `brand_assets.kind` for a brand kit's logo; the watermark rows are `watermark`. */
export const LOGO_ASSET_KIND = "logo";

/** The name v1's one kit per workspace is stored under (`brand_kits.name` is required). */
export const DEFAULT_BRAND_KIT_NAME = "Brand kit";

/**
 * A run's cover image (2026-10-04, audiograms): the artwork a clip of a
 * source with no picture is drawn with, given on the start form. Kept as a
 * `brand_assets` row of this kind, so workspace erasure deletes it with the
 * workspace's other images.
 */
export const COVER_ASSET_KIND = "cover";

/** The largest cover a run takes: a podcast's cover is a few megabytes at 3000 x 3000. */
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

/** The smallest and largest side a cover may have, in pixels. */
export const COVER_MIN_SIDE = 64;
export const COVER_MAX_SIDE = 4096;

/** Error codes for a run's cover (`POST /repurpose/covers`). */
export const COVER_ERROR_CODES = {
  /** Not a PNG, JPEG or WebP, or its declared type does not match its bytes. */
  invalid: "repurpose/cover_invalid",
  /** Over {@link COVER_MAX_BYTES}. */
  tooLarge: "repurpose/cover_too_large",
  /** Smaller or larger than a cover can usefully be. */
  badSize: "repurpose/cover_bad_size",
  /** `complete` before the bytes arrived. */
  notUploaded: "repurpose/cover_not_uploaded",
  /** The asset id names nothing that is this workspace's cover. */
  notFound: "repurpose/cover_not_found",
} as const;

/** Error codes (CONTRACTS §8: `namespace/slug`). */
export const BRAND_KIT_ERROR_CODES = {
  /** A typeface that is not in the bundled catalogue. */
  fontUnknown: "brand_kit/font_unknown",
  /** Not a PNG, JPEG or WebP, or its declared type does not match its bytes. */
  logoInvalid: "brand_kit/logo_invalid",
  /** Over {@link LOGO_MAX_BYTES}. */
  logoTooLarge: "brand_kit/logo_too_large",
  /** Smaller or larger than a logo can usefully be. */
  logoBadSize: "brand_kit/logo_bad_size",
  /** `complete` before the bytes arrived. */
  logoNotUploaded: "brand_kit/logo_not_uploaded",
  /** The asset id names something that is not this workspace's logo. */
  logoNotFound: "brand_kit/logo_not_found",
} as const;

/**
 * Logo uploads, per user: a person replacing a logo a few times over tries
 * nothing like this many, and each upload is a signed PUT and a read-back.
 */
export const BRAND_KIT_RATE_LIMITS = {
  logo: {
    name: "brand-kit:logo:user",
    by: "user",
    capacity: 30,
    refillPerSec: 30 / 3600,
  },
  /** A cover per run started from an audio file: a batch of twenty, and room to redo them. */
  cover: {
    name: "repurpose:cover:user",
    by: "user",
    capacity: 60,
    refillPerSec: 60 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;
