import { z } from "zod";

import {
  BrandKitSettingsSchema,
  END_CARD_CTA_MAX,
  END_CARD_HANDLE_MAX,
  type BrandKitSettings,
} from "@montaj/edg";

import {
  LOGO_CONTENT_TYPE_LIST,
  MUSIC_CONTENT_TYPE_LIST,
  MUSIC_TITLE_MAX,
  type LogoContentType,
  type MusicContentType,
} from "./brand-kit.constants.js";
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

const musicContentType = z.enum(
  MUSIC_CONTENT_TYPE_LIST as [MusicContentType, ...MusicContentType[]],
);

/**
 * `POST /brand-kit/music` (2026-10-04): what is about to be uploaded, and the
 * confirmation that the person has the rights to use it - required, and asked
 * again on `complete`, where it is recorded with who gave it and when.
 */
export const musicUploadSchema = z
  .object({
    contentType: musicContentType,
    sizeBytes: z.number().int().min(1),
    rightsAttested: z.boolean(),
  })
  .strict();
export class MusicUploadDto extends zodDto(musicUploadSchema) {}

/** `POST /brand-kit/music/{assetId}/complete`: the type it was signed for, the confirmation, its name. */
export const musicCompleteSchema = z
  .object({
    contentType: musicContentType,
    rightsAttested: z.boolean(),
    /** The file's name without its extension, for the editor's row; display only. */
    title: z.string().trim().max(MUSIC_TITLE_MAX).optional(),
  })
  .strict();
export class MusicCompleteDto extends zodDto(musicCompleteSchema) {}

/** The kit's music (2026-10-04). */
export const brandKitMusicViewSchema = z.object({
  assetId: z.string(),
  format: z.enum(["mp3", "wav", "m4a"]),
  contentType: musicContentType,
  durationMs: z.number().int(),
  sizeBytes: z.number().int().nullable(),
  title: z.string().nullable(),
  /** Signed for an hour: the settings page plays it. */
  url: z.string(),
  /** Who confirmed the rights to use it, and when. */
  rightsAttestedAt: z.string().nullable(),
  rightsAttestedBy: z.string().nullable(),
});

export const musicUploadTicketSchema = z.object({
  assetId: z.string(),
  /** PUT the bytes here, with this `Content-Type`. */
  uploadUrl: z.string(),
  contentType: musicContentType,
  expiresAt: z.string(),
  maxBytes: z.number().int(),
});

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
  /** The workspace's own music (2026-10-04); whether to use it, and how loud, is `settings.music`. */
  music: brandKitMusicViewSchema.nullable(),
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
    musicMaxBytes: z.number().int(),
    musicContentTypes: z.array(z.string()),
    musicMinDurationMs: z.number().int(),
    musicMaxDurationMs: z.number().int(),
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
export type BrandKitMusicView = z.infer<typeof brandKitMusicViewSchema>;
export type MusicUploadTicket = z.infer<typeof musicUploadTicketSchema>;
export type MusicUploadInput = z.infer<typeof musicUploadSchema>;
export type MusicCompleteInput = z.infer<typeof musicCompleteSchema>;
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
