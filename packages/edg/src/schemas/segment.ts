import { z } from "zod";

import {
  JsonObjectSchema,
  MsSchema,
  PresetIdSchema,
  SeqKeySchema,
  StyleRefSchema,
  UlidSchema,
  WordIdSchema,
} from "./primitives.js";

/**
 * On-canvas placement override. `x`/`y` are fractions of the canvas (0 = left or
 * top edge, 1 = right or bottom edge) so a segment keeps its position across
 * aspect ratios; `anchor` names the box corner they address ("center",
 * "bottom-center", …) and stays a free string per CONTRACTS §2.
 */
export const PositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    anchor: z.string().min(1).max(32),
  })
  .meta({ id: "Position", title: "Position" });

/** One emphasised word inside a segment, rendered with `presetId` from the style. */
export const EmphasisSchema = z
  .object({
    wordId: WordIdSchema,
    presetId: PresetIdSchema,
  })
  .meta({ id: "Emphasis", title: "Emphasis" });

/**
 * A caption segment: a row of `edg_segments` (D28). It addresses the transcript
 * by stable word ids and denormalises the times so the timeline can draw without
 * loading chunks.
 */
export const SegmentSchema = z
  .object({
    id: UlidSchema,
    /** Fractional ordering key; see `@montaj/edg/seq`. */
    seq: SeqKeySchema,
    startWordId: WordIdSchema,
    endWordId: WordIdSchema,
    startMs: MsSchema,
    endMs: MsSchema,
    styleRef: StyleRefSchema.optional(),
    /** Per-script text override, keyed by `ScriptId`; empty means "use the words". */
    textOverrides: z.record(z.string(), z.string()).optional(),
    emphasis: z.array(EmphasisSchema).optional(),
    position: PositionSchema.optional(),
    /** Style overrides for this segment only, merged over the resolved style. */
    overrides: JsonObjectSchema.optional(),
    hidden: z.boolean().optional(),
  })
  .meta({ id: "Segment", title: "Segment", description: "A caption segment (CONTRACTS §2)" });

export type Position = z.infer<typeof PositionSchema>;
export type Emphasis = z.infer<typeof EmphasisSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
