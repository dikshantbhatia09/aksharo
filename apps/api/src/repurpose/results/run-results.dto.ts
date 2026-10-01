import { z } from "zod";

import { zodDto } from "../../common/index.js";
import { AUTOMATION_MODES } from "../repurpose.constants.js";
import { createRunSchema } from "../repurpose.dto.js";

/**
 * Requests for a run's results page (2026-10-01, the OpusClip parity work):
 * a clip's title edited in place, Autopilot's hook titles switched off or on
 * for the whole run, and what a new run would cost before it starts.
 */

/** `PUT /repurpose/runs/{id}/candidates/{candidateId}/title`. */
export const retitleSchema = z.object({ title: z.string().trim().min(1).max(160) }).strict();
export class RetitleDto extends zodDto(retitleSchema) {}
export type RetitleInput = z.infer<typeof retitleSchema>;

/** `PUT /repurpose/runs/{id}/hook-titles`. */
export const hookTitlesSchema = z.object({ enabled: z.boolean() }).strict();
export class HookTitlesDto extends zodDto(hookTitlesSchema) {}
export type HookTitlesInput = z.infer<typeof hookTitlesSchema>;

/** `GET /repurpose/estimate`: a video's length when it is known (an upload), and the setup. */
export const estimateQuerySchema = z
  .object({
    durationMs: z.coerce
      .number()
      .int()
      .positive()
      .max(48 * 60 * 60_000)
      .optional(),
    automation: z.enum(AUTOMATION_MODES).default("auto"),
    clipLength: z.enum(["short", "medium", "long"]).optional(),
    /**
     * "1" when the run starts with the person's own captions (2026-10-01):
     * they are aligned instead of transcribed, so finding moments is free.
     */
    captions: z.literal("1").optional(),
  })
  .strict();
export class EstimateQueryDto extends zodDto(estimateQuerySchema) {}
export type EstimateQuery = z.infer<typeof estimateQuerySchema>;

/**
 * A workspace's default setup for new runs (2026-10-01, OpusClip's "Save
 * settings above as default"): a run's `setup` without what belongs to one
 * video (its window, an audio file's cover, captions written for it).
 */
export const runDefaultsSetupSchema = createRunSchema.shape.setup.omit({
  window: true,
  audiogram: true,
  captions: true,
});
export type RunDefaultsSetup = z.infer<typeof runDefaultsSetupSchema>;

/** `PUT /repurpose/defaults`. */
export const runDefaultsSchema = z.object({ setup: runDefaultsSetupSchema }).strict();
export class RunDefaultsDto extends zodDto(runDefaultsSchema) {}

/** `GET /repurpose/runs/{id}/search?q=`: a question about the run's moments. */
export const runSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) }).strict();
export class RunSearchQueryDto extends zodDto(runSearchQuerySchema) {}
