import { z } from "zod";

import { zodDto } from "../../common/index.js";

/** `POST /v1/runs` (2026-10-01): a link and what to change from the saved setup. */
export const v1StartRunSchema = z
  .object({
    url: z.string().trim().min(1).max(2_048),
    /** The caller owns the video or has permission to use it. */
    rightsAttested: z.literal(true),
    /** A BCP-47 tag, or `auto` to detect it. */
    sourceLanguage: z.string().trim().min(2).max(35).optional(),
    /** A caption look the workspace can use (`GET /styles`). */
    styleId: z.string().trim().min(1).max(64).optional(),
    /** Every moment becomes a clip, in every size, with nobody at the page. */
    autopilot: z.boolean().optional(),
    clipLength: z.enum(["short", "medium", "long"]).optional(),
    /** What the clips should be about. */
    topic: z.string().trim().min(2).max(200).optional(),
    /** Where to start in a long video. */
    startAtMs: z.number().int().min(0).optional(),
  })
  .strict();
export class V1StartRunDto extends zodDto(v1StartRunSchema) {}
export type V1StartRun = z.infer<typeof v1StartRunSchema>;

export const v1ListRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
  })
  .strict();
export class V1ListRunsQueryDto extends zodDto(v1ListRunsQuerySchema) {}

export const v1SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) }).strict();
export class V1SearchQueryDto extends zodDto(v1SearchQuerySchema) {}
