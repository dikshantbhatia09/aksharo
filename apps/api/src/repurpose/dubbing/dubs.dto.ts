import { z } from "zod";

import { DUB_LANGUAGES, DUB_LIMITS } from "@montaj/repurpose-contracts";

import { zodDto } from "../../common/index.js";

/**
 * `POST /repurpose/runs/{runId}/clips/{clipId}/dubs` (2026-10-04): the
 * languages to dub the clip into, as the vendor spells them, and the person's
 * word that they may clone the speaker's voice. `consent` is a boolean rather
 * than `true` only, so a missing tick is refused with its own words
 * (`dub/consent_required`) instead of a validation error.
 */
export const createDubSchema = z.object({
  languages: z
    .array(z.enum(DUB_LANGUAGES))
    .min(1)
    .max(DUB_LIMITS.maxLanguages)
    .refine((codes) => new Set(codes).size === codes.length, "A language is asked for once."),
  consent: z.boolean(),
});
export class CreateDubDto extends zodDto(createDubSchema) {}
export type CreateDubInput = z.infer<typeof createDubSchema>;
