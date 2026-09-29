import { z } from "zod";

import {
  BrandKitSettingsSchema,
  END_CARD_CTA_MAX,
  END_CARD_HANDLE_MAX,
  type BrandKitSettings,
} from "@montaj/edg";

import { LOGO_CONTENT_TYPE_LIST, type LogoContentType } from "./brand-kit.constants.js";
import { zodDto } from "../common/index.js";

/**
 * Request bodies and answers for the brand kit (2026-10-02).
 *
 * The settings' shape is `@montaj/edg`'s `BrandKitSettingsSchema`, the one the
 * web's settings page and Autopilot's finishing pass read too; the service adds
 * what a schema cannot know (a typeface must be one this product bundles).
 */

const contentType = z.enum(LOGO_CONTENT_TYPE_LIST as [LogoContentType, ...LogoContentType[]]);

/** `PUT /brand-kit`: the whole kit, every field. */
export class UpdateBrandKitDto extends zodDto(BrandKitSettingsSchema) {}

/** `POST /brand-kit/logo`: what is about to be uploaded. The size is checked, then trusted no further. */
export const logoUploadSchema = z
  .object({
    contentType,
    sizeBytes: z.number().int().min(1),
  })
  .strict();
export class LogoUploadDto extends zodDto(logoUploadSchema) {}

/** `POST /brand-kit/logo/{assetId}/complete`: the type the upload was signed for. */
export const logoCompleteSchema = z.object({ contentType }).strict();
export class LogoCompleteDto extends zodDto(logoCompleteSchema) {}

/** The logo a kit adds to clips. */
export const brandKitLogoViewSchema = z.object({
  assetId: z.string(),
  format: z.enum(["png", "jpeg", "webp"]),
  contentType,
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.number().int().nullable(),
  /** Signed for an hour. */
  url: z.string(),
});

export const brandKitViewSchema = z.object({
  /** False until the kit is first saved: `settings` are then the defaults, and Autopilot adds nothing. */
  exists: z.boolean(),
  settings: BrandKitSettingsSchema,
  logo: brandKitLogoViewSchema.nullable(),
  /**
   * Every logo this workspace keeps — the kit's, and older ones clips still
   * carry — by asset id, each signed for an hour: what the editor and the
   * previews draw a logo overlay from.
   */
  images: z.record(z.string(), z.string()),
  /** The typefaces a kit may name: the bundled catalogue. */
  fontFamilies: z.array(z.string()),
  limits: z.object({
    logoMaxBytes: z.number().int(),
    logoContentTypes: z.array(z.string()),
    logoMinSide: z.number().int(),
    logoMaxSide: z.number().int(),
    ctaMax: z.literal(END_CARD_CTA_MAX),
    handleMax: z.literal(END_CARD_HANDLE_MAX),
  }),
  updatedAt: z.string().nullable(),
});

export const logoUploadTicketSchema = z.object({
  assetId: z.string(),
  /** PUT the bytes here, with this `Content-Type`. */
  uploadUrl: z.string(),
  contentType,
  expiresAt: z.string(),
  maxBytes: z.number().int(),
});

export type BrandKitLogoView = z.infer<typeof brandKitLogoViewSchema>;
export type BrandKitView = z.infer<typeof brandKitViewSchema>;
export type LogoUploadTicket = z.infer<typeof logoUploadTicketSchema>;
export type LogoUploadInput = z.infer<typeof logoUploadSchema>;
export type LogoCompleteInput = z.infer<typeof logoCompleteSchema>;
export type { BrandKitSettings };

/**
 * A run's cover (2026-10-04, audiograms): `POST /repurpose/covers` takes what
 * is about to be uploaded, as a logo does, and `complete` the type it was
 * signed for. Covers may be larger than logos (`COVER_MAX_BYTES`).
 */
export class CoverUploadDto extends zodDto(logoUploadSchema) {}
export class CoverCompleteDto extends zodDto(logoCompleteSchema) {}

/** A run's cover, checked: its id goes in `setup.audiogram.coverAssetId`. */
export const coverViewSchema = z.object({
  assetId: z.string(),
  format: z.enum(["png", "jpeg", "webp"]),
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.number().int().nullable(),
  /** Signed for an hour: the start form shows it back. */
  url: z.string(),
});

export type CoverView = z.infer<typeof coverViewSchema>;
