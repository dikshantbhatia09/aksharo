import { z } from "zod";

/**
 * Plain Zod schemas, parsed by hand in the controller rather than through
 * `common/validation/zod-validation.pipe.ts`'s `zodDto` helper.
 *
 * `zodDto`'s generated class currently fails `tsc` in this repository (`Base
 * constructor return type 'unknown' is not an object type...`, reproduced on
 * `main` in `src/edg/edg.dto.ts` before this work package touched anything —
 * see the work package report's "pre-existing build failures" note). Using it
 * here would only add more instances of the same pre-existing breakage
 * outside this work package's file boundary
 * (`apps/api/src/common/validation/**`), which this work package must not
 * modify. `schema.parse(body)` gives the same runtime validation without it.
 */

const IsoDate = z
  .string()
  .min(4)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not a date" })
  .transform((value) => new Date(value));

export const UpsertTaxRegistrationSchema = z.object({
  jurisdiction: z.string().length(2),
  taxIdType: z.string().min(1).max(32),
  taxId: z.string().min(1).max(64),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullish(),
  filingCadence: z.string().min(1).max(32).optional(),
  lutNumber: z.string().min(1).max(64).nullish(),
  lutValidTo: IsoDate.nullish(),
});

export type UpsertTaxRegistrationBody = z.infer<typeof UpsertTaxRegistrationSchema>;
