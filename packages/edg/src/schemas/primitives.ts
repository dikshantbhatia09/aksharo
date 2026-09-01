import { z } from "zod";

import { ULID_PATTERN, WORD_ID_PATTERN, type WordId } from "../ids.js";
import { SEQ_KEY_PATTERN } from "../seq.js";

/** Every id in the platform is a ULID (CONTRACTS §0). */
export const UlidSchema = z
  .string()
  .regex(ULID_PATTERN, "expected a ULID: 26 Crockford base-32 characters")
  .meta({
    id: "Ulid",
    title: "Ulid",
    description: "ULID identifier (CONTRACTS §0)",
    examples: ["01JBZ9F8Q0000000000000000A"],
  });

/**
 * Stable word id, `"<chunkIdx>:<n>"`.
 *
 * The runtime schema is a plain string with the D28 pattern; the static type is
 * narrowed to the frozen `WordId` template literal from CONTRACTS §2 so every
 * inferred document type carries it. The cast only changes types — the emitted
 * JSON Schema still sees a `string` with a `pattern`.
 */
export const WordIdSchema = z
  .string()
  .regex(WORD_ID_PATTERN, 'expected a word id of the form "<chunkIdx>:<n>"')
  .meta({
    title: "WordId",
    description: 'Stable word id "<chunkIdx>:<n>", allocated once and never reused (D28)',
    examples: ["0:0", "3:1274"],
  }) as unknown as z.ZodType<WordId, WordId>;

/** Fractional ordering key for `Segment.seq` (D28). */
export const SeqKeySchema = z
  .string()
  .regex(SEQ_KEY_PATTERN, "expected a base-62 fractional key not ending in 0")
  .meta({
    id: "SeqKey",
    title: "SeqKey",
    description: "Fractional ordering key; sorts lexicographically",
    examples: ["V", "1B"],
  });

/** Media time in whole milliseconds, never negative (CONTRACTS §0 — `*Ms`). */
export const MsSchema = z.number().int().min(0).meta({ title: "Milliseconds" });

/** A signed millisecond offset (an SFX may fire before the item it belongs to). */
export const OffsetMsSchema = z.number().int().meta({ title: "OffsetMilliseconds" });

/** Confidence, `0` (worthless) to `1` (certain). */
export const ConfidenceSchema = z.number().min(0).max(1).meta({ title: "Confidence" });

/** Gain in decibels, clamped to a range every renderer can honour. */
export const GainDbSchema = z.number().min(-60).max(24).meta({ title: "GainDb" });

/**
 * Reference to a caption style: a system style id (`punch-pop`), a workspace
 * preset ULID, or `inline:<key>` into `EdgHot.styles.inline`.
 */
export const StyleRefSchema = z
  .string()
  .min(1)
  .max(128)
  .meta({ id: "StyleRef", title: "StyleRef" });

/** Key into a preset table (emphasis presets, animation presets). */
export const PresetIdSchema = z.string().min(1).max(64).meta({ id: "PresetId", title: "PresetId" });

/** Scripts a transcript can carry (07 §EDG JSON schema). */
export const ScriptIdSchema = z
  .enum(["roman", "native", "en", "translated"])
  .meta({ id: "ScriptId", title: "ScriptId" });

/** Canvas aspect ratios the product supports (CONTRACTS §2). */
export const AspectSchema = z
  .enum(["9:16", "16:9", "1:1", "4:5"])
  .meta({ id: "Aspect", title: "Aspect" });

/**
 * An opaque JSON object. Used where CONTRACTS §2 freezes the field as
 * `Record<string, unknown>` — the shape belongs to the producing subsystem.
 */
export const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .meta({ id: "JsonObject", title: "JsonObject" });

/** ISO-8601 instant (CONTRACTS §0 — times are ISO-8601 in JSON). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true }).meta({ title: "IsoDateTime" });

/** Reference to a stored keyframe curve (packed float32 rows, D28). */
export const KeyframesRefSchema = z
  .string()
  .min(1)
  .max(256)
  .meta({ id: "KeyframesRef", title: "KeyframesRef" });

export type Ulid = z.infer<typeof UlidSchema>;
export type SeqKey = z.infer<typeof SeqKeySchema>;
export type ScriptId = z.infer<typeof ScriptIdSchema>;
export type Aspect = z.infer<typeof AspectSchema>;
export type StyleRef = z.infer<typeof StyleRefSchema>;
export type PresetId = z.infer<typeof PresetIdSchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export type { WordId };
