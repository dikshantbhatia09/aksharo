import { BRAND } from "@montaj/config";
import { z } from "zod";

import type { RateLimitRule } from "../common/guards/index.js";
import type { EntitlementView } from "../workspaces/entitlement.service.js";

/**
 * Error codes, limits and the licence attestation text for `/fonts`.
 *
 * Numbers live here rather than in the environment for the reason
 * `projects.constants.ts` gives: CONTRACTS §1 is a frozen list of *product*
 * configuration. What is genuinely per-plan — how many custom fonts a workspace
 * may keep — is read off the entitlement.
 */
export const FONT_ERRORS = {
  notFound: "fonts/not_found",
  invalidState: "fonts/invalid_state",
  attestationRequired: "fonts/attestation_required",
  attestationStale: "fonts/attestation_stale",
  planLimit: "fonts/plan_limit_reached",
  uploadMissing: "fonts/upload_missing",
  tooLarge: "fonts/too_large",
  unknownFile: "fonts/unknown_file",
} as const;

/**
 * The licence warranty an uploader gives (F-305, D67).
 *
 * It is versioned because it is a **record of what somebody agreed to**: if the
 * wording changes, an attestation made against the old text is still evidence of
 * the old promise, and the row has to say which. `attestedAt` plus this version
 * plus `licenceAttestedBy` is the whole warranty record; `licenceNote` is the
 * uploader's own free-text (a licence number, a foundry order id).
 */
export const FONT_ATTESTATION = {
  version: "2026-09-02",
  text:
    "I warrant that I hold a licence permitting this font to be embedded in " +
    "video I create with this service, that I have the right to upload it, and " +
    `I indemnify ${BRAND.name} against any claim arising from its use.`,
} as const;

/** Attestation versions still accepted on a new upload. */
export const ACCEPTED_ATTESTATION_VERSIONS: readonly string[] = [FONT_ATTESTATION.version];

/**
 * Largest custom font, 8 MiB — the same cap `@montaj/fonts` validates against.
 *
 * The presigned PUT is signed for the declared size and the completion re-reads
 * the store's own byte count, so the cap is enforced twice: once before anything
 * is signed and once against the object that actually arrived.
 */
export const MAX_FONT_UPLOAD_BYTES = 8 * 1024 * 1024;

/** How long a font upload URL stays valid. A font is small; five minutes is ample. */
export const FONT_UPLOAD_URL_TTL_SECONDS = 5 * 60;

/** How long a font download URL stays valid (07 pins derived URLs at five minutes). */
export const FONT_DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * How long the browser may cache a bundled font file.
 *
 * A year, immutable: the file name carries the family, the weight and nothing
 * else, but the *manifest* carries a SHA-256 and the pack is rebuilt only when
 * the catalogue changes, at which point the deployment changes too. A stale font
 * would be the same typeface, so the trade is safe and the saving is every
 * caption in the editor drawing without a round trip.
 */
export const BUNDLED_FONT_CACHE_SECONDS = 365 * 24 * 60 * 60;

/** Tag every font object carries, so retention and audits can select them. */
export const FONT_OBJECT_TAGS = { class: "fonts" } as const;

export const FONT_RATE_LIMITS = {
  /** Signing an upload is cheap, but a plan allows at most fifty fonts. */
  initUpload: { name: "fonts:init:user", by: "user", capacity: 60, refillPerSec: 60 / 3600 },
  /**
   * Completion parses and subsets an attacker-supplied file **in this process**
   * (THREAT-MODEL T7), so it is the tightest bucket in the module: thirty an
   * hour is more custom fonts than any plan allows, and a script that found a
   * pathological font cannot spend the API on it.
   */
  complete: { name: "fonts:complete:user", by: "user", capacity: 30, refillPerSec: 30 / 3600 },
} as const satisfies Record<string, RateLimitRule>;

/** Free-plan value from `prisma/seed-data.ts`; the floor for every fallback. */
export const FREE_PLAN_CUSTOM_FONTS = 0;

/**
 * How many custom fonts this workspace may keep (`04 §Plans`: 0/5/15/50/50).
 *
 * A missing or malformed entitlement falls back to the Free plan's zero, never
 * to "unlimited" — the same rule `plan-limits.ts` follows for media.
 */
export function customFontLimitFor(entitlement: EntitlementView): number {
  const value = entitlement.entitlements["customFonts"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : FREE_PLAN_CUSTOM_FONTS;
}

/**
 * What `fonts.metrics` holds.
 *
 * `06-data-model.md` gives the column to "ascent, descent, unitsPerEm,
 * coverage"; A18b keeps to that and adds the rest of the pipeline's record in
 * the same document rather than adding columns, because the Prisma schema is
 * A03's and a font table is not worth a cross-agent migration. Everything here
 * is derived from bytes the API has already validated, so a row that lost it
 * could be rebuilt by re-running the pipeline.
 */
export const fontMetricsSchema = z.object({
  status: z.enum(["pending", "ready", "failed"]).default("pending"),
  sanitised: z.boolean().default(false),
  /** ISO 15924 tags the subset was cut for. */
  scripts: z.array(z.string().min(2).max(8)).default([]),
  /** `WordScript` hints for `FontRegistry`. */
  wordScripts: z.array(z.enum(["latin", "devanagari", "tamil", "other"])).default([]),
  weight: z.number().int().min(100).max(900).default(400),
  italic: z.boolean().default(false),
  unitsPerEm: z.number().int().positive().optional(),
  ascent: z.number().optional(),
  descent: z.number().optional(),
  lineGap: z.number().optional(),
  numGlyphs: z.number().int().nonnegative().optional(),
  /** Coverage ratio per ISO tag, as the validator measured it. */
  coverage: z.record(z.string(), z.number()).default({}),
  /** Container of the stored original. */
  format: z.enum(["ttf", "otf", "woff", "woff2"]).optional(),
  originalSizeBytes: z.number().int().nonnegative().optional(),
  woff2SizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().length(64).optional(),
  woff2Sha256: z.string().length(64).optional(),
  /** The attestation record: which text the uploader agreed to. */
  attestationVersion: z.string().max(32).optional(),
  /** Why a font was refused, when `status` is `failed`. */
  failureCode: z.string().max(64).optional(),
  filename: z.string().max(255).optional(),
});

export type FontMetrics = z.infer<typeof fontMetricsSchema>;

/** Parse a `metrics` blob, filling in the defaults a pending row has. */
export function readFontMetrics(value: unknown): FontMetrics {
  const parsed = fontMetricsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : fontMetricsSchema.parse({});
}
