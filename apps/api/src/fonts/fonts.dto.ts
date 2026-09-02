import { z } from "zod";

import { SCRIPT_TAGS } from "@montaj/fonts";

import { MAX_FONT_UPLOAD_BYTES } from "./fonts.constants.js";
import { zodDto } from "../common/index.js";

/** Request and response schemas for `/fonts` and `/workspaces/{id}/fonts`. */

/**
 * `POST /workspaces/{id}/fonts/init`.
 *
 * `scripts` is the uploader's claim about what the font is for. It is not taken
 * on trust — `complete` checks each claim against the font's own character map
 * and refuses `fonts/script_not_covered` — but it is what the subset is cut to,
 * so declaring Devanagari on a Latin-only face is a refusal rather than a
 * silently useless font.
 */
export const initFontUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(MAX_FONT_UPLOAD_BYTES),
  /** Family name to show in the picker; the font's own name wins if it has one. */
  family: z.string().trim().min(1).max(128).optional(),
  scripts: z.array(z.enum(SCRIPT_TAGS)).max(SCRIPT_TAGS.length).optional(),
});

export class InitFontUploadDto extends zodDto(initFontUploadSchema) {}

/**
 * `POST /fonts/{fontId}/complete`.
 *
 * `licenceAttested` must be exactly `true`: the warranty of F-305 and D67 is
 * the whole reason a custom font may be embedded in a rendered video, so an
 * omitted or false flag is `fonts/attestation_required`, not a default.
 */
export const completeFontUploadSchema = z.object({
  licenceAttested: z.boolean(),
  /** The uploader's own record: a licence number, a foundry order id. */
  licenceNote: z.string().trim().max(500).optional(),
  /** Which attestation text was shown. Defaults to the current one. */
  attestationVersion: z.string().trim().max(32).optional(),
});

export class CompleteFontUploadDto extends zodDto(completeFontUploadSchema) {}

// --- Response shapes (documentation only; the services build the objects) ----

export const fontFaceViewSchema = z.object({
  id: z.string(),
  family: z.string(),
  weight: z.number().int(),
  italic: z.boolean(),
  file: z.string(),
  scripts: z.array(z.string()),
  scriptTags: z.array(z.string()),
  woff2: z.string().optional(),
  sizeBytes: z.number().int(),
  woff2SizeBytes: z.number().int().optional(),
  sha256: z.string(),
  licence: z.string().optional(),
  licenceFile: z.string().optional(),
  url: z.string().optional(),
  woff2Url: z.string().optional(),
});

export const fontManifestViewSchema = z.object({
  v: z.literal(1),
  origin: z.enum(["bundled", "workspace"]),
  generatedAt: z.string().optional(),
  fonts: z.array(fontFaceViewSchema),
  /** ISO-8601; when the signed URLs on the faces stop working. Bundled: absent. */
  expiresAt: z.string().optional(),
});

export const fontCatalogueEntrySchema = z.object({
  family: z.string(),
  weights: z.array(z.number().int()),
  scripts: z.array(z.string()),
  scriptNames: z.array(z.string()),
  licence: z.string(),
  licenceUrl: z.string(),
  totalBytes: z.number().int(),
  note: z.string(),
});

export const fontCatalogueSchema = z.object({
  version: z.literal(1),
  /** The families a picker offers, with their script coverage tags. */
  families: z.array(fontCatalogueEntrySchema),
  /** BCP-47 tag, name and script for each of the 22 scheduled languages. */
  languages: z.array(
    z.object({ code: z.string(), name: z.string(), script: z.string(), scriptName: z.string() }),
  ),
});

export const workspaceFontSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  family: z.string(),
  style: z.string(),
  status: z.enum(["pending", "ready", "failed"]),
  sanitised: z.boolean(),
  weight: z.number().int(),
  italic: z.boolean(),
  scripts: z.array(z.string()),
  sizeBytes: z.number().int().nullable(),
  woff2SizeBytes: z.number().int().nullable(),
  filename: z.string().nullable(),
  licenceAttestedBy: z.string().nullable(),
  attestedAt: z.string().nullable(),
  attestationVersion: z.string().nullable(),
  licenceNote: z.string().nullable(),
  servedOnlyToWorkspace: z.boolean(),
  createdAt: z.string(),
});

export const fontUploadTicketSchema = z.object({
  fontId: z.string(),
  /** Single-shot presigned PUT; a font is far too small for multipart. */
  url: z.string(),
  key: z.string(),
  expiresAt: z.string(),
  /** The exact text the uploader must be shown before `complete` is called. */
  attestation: z.object({ version: z.string(), text: z.string() }),
  /** How many custom fonts the plan allows, and how many are in use. */
  quota: z.object({ used: z.number().int(), limit: z.number().int(), planKey: z.string() }),
  font: workspaceFontSchema,
});

export const fontUrlsSchema = z.object({
  fontId: z.string(),
  /** The sanitised original, for the cloud renderer and the desktop app. */
  url: z.string(),
  /** The subset WOFF2, for the browser. Absent until the font is sanitised. */
  woff2Url: z.string().optional(),
  expiresAt: z.string(),
});
