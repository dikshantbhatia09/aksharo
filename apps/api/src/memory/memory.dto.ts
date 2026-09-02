import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * `memory_entries.kind` (F-204, D62). `spelling` and `glossary` both feed A11's
 * post-correction matcher (`transcripts/postprocess/glossary.source.ts`) — the
 * distinction is provenance, not shape: a `glossary` term is what the user typed
 * into Settings, a `spelling` is what B09 inferred from a "Fix spelling
 * everywhere" correction. `timingNudge` is the rolling median caption-offset
 * learned from A17 drag deltas; `stylePref` is the last style/template used per
 * aspect ratio.
 */
export const MEMORY_KINDS = ["spelling", "glossary", "timingNudge", "stylePref"] as const;
export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * `memory_entries.value` (JSONB) — the `MemoryEntrySchema` the Prisma schema
 * comment names. Deliberately the same `{term|value, aliases}` shape A11's
 * `parseTerm()` already reads (`glossary.source.ts`), so a row this module
 * writes needs no translation to be consumed there: `value.value` is the
 * canonical/correct text, `value.aliases` are other spellings that mean it
 * (for a `spelling` entry, the observed wrong spelling is stored as an alias).
 */
export const memoryValueSchema = z.object({
  /** Stable lookup key within `(workspaceId, kind)` — normalised lowercase for spelling/glossary. */
  key: z.string().trim().min(1).max(200),
  /** The canonical/correct text, or the stored value for timingNudge/stylePref. */
  value: z.string().trim().min(1).max(1000),
  /** Other spellings that resolve to the same term (spelling/glossary only). */
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  /** Where this entry came from: `manual`, `import`, `autoSpellingFix`, `autoTimingDrag`, `autoStyleUse`. */
  source: z.string().trim().min(1).max(64).default("manual"),
  /** Per-device override — synced with the account but not applied cross-device (F-204). */
  deviceOnly: z.boolean().default(false),
  /** Times this entry has been applied; refreshed alongside `lastUsedAt`. */
  hits: z.number().int().min(0).default(0),
});
export type MemoryValue = z.infer<typeof memoryValueSchema>;

export const createMemoryEntrySchema = z.object({
  kind: memoryKindSchema,
  key: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(1000),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  source: z.string().trim().min(1).max(64).default("manual"),
  deviceOnly: z.boolean().default(false),
});
export class CreateMemoryEntryDto extends zodDto(createMemoryEntrySchema) {}

export const updateMemoryEntrySchema = z
  .object({
    value: z.string().trim().min(1).max(1000).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    deviceOnly: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "At least one field must be given.");
export class UpdateMemoryEntryDto extends zodDto(updateMemoryEntrySchema) {}

/** Glossary bulk import: one term per line, `term` or `term,alias1;alias2`. */
export const importGlossarySchema = z.object({
  csv: z.string().trim().min(1).max(200_000),
});
export class ImportGlossaryDto extends zodDto(importGlossarySchema) {}

export const spellingFixHookSchema = z.object({
  wrong: z.string().trim().min(1).max(200),
  right: z.string().trim().min(1).max(200),
  script: z.string().trim().min(1).max(32).optional(),
});
export class SpellingFixHookDto extends zodDto(spellingFixHookSchema) {}

export const timingNudgeHookSchema = z.object({
  /** Signed drag delta in milliseconds, as A17 emits it through the sink. */
  deltaMs: z.number().int().min(-10_000).max(10_000),
});
export class TimingNudgeHookDto extends zodDto(timingNudgeHookSchema) {}

export const stylePrefHookSchema = z.object({
  aspect: z.string().trim().min(1).max(32),
  styleId: z.string().trim().min(1).max(200),
});
export class StylePrefHookDto extends zodDto(stylePrefHookSchema) {}

// --- Response shapes (documentation only) -----------------------------------

export const memoryEntryResponseSchema = z.object({
  id: z.string(),
  kind: memoryKindSchema,
  key: z.string(),
  value: z.string(),
  aliases: z.array(z.string()).optional(),
  source: z.string(),
  deviceOnly: z.boolean(),
  hits: z.number(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const importGlossaryResultSchema = z.object({
  imported: z.number(),
  updated: z.number(),
  skipped: z.number(),
});
