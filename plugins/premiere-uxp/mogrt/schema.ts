import { z } from "zod";

/**
 * Schema for this plugin's `definition.json` — the small sidecar JSON this
 * package generates and packages inside the Aksharo caption `.mogrt` zip
 * alongside the (human-authored, not present here) `.aep`.
 *
 * This is **not** a re-implementation of Adobe's internal MOGRT/EGP binary
 * format — that format is proprietary, produced by After Effects' own "Export
 * Motion Graphics Template" command, and cannot be authored or verified without
 * a real AE install (none exists on this build host). `definition.json` is our
 * own sidecar metadata: it records the param order/names/types/defaults this
 * plugin's code (`setMogrtParams`, the start-up self-test, `verify.ts`) relies
 * on, so a human authoring the real `.aep` in AE's Essential Graphics panel has
 * a machine-checked source of truth for exactly what to expose, in exactly what
 * order (see `docs/MOGRT-PARAMS.md` and `docs/README-AUTHORING.md`).
 */

export const MOGRT_DEFINITION_SCHEMA_VERSION = 1 as const;

export const MogrtParamTypeSchema = z.enum(["text", "font", "color", "percent", "number"]);

export const MogrtParamDefSchema = z.object({
  index: z.number().int().min(0),
  name: z.string().min(1),
  displayName: z.string().min(1),
  type: MogrtParamTypeSchema,
  defaultValue: z.union([z.string(), z.number()]),
  description: z.string().min(1),
});

export const MogrtDefinitionSchema = z
  .object({
    schemaVersion: z.literal(MOGRT_DEFINITION_SCHEMA_VERSION),
    /** Identifies which generator/version produced this file. */
    generator: z.string().min(1),
    /** Human-facing name of the MOGRT as it appears in Premiere's Essential Graphics browser. */
    mogrtName: z.string().min(1),
    /**
     * True only for the committed CI placeholder (`mogrt/placeholder.mogrt`):
     * a real `.aep`-backed MOGRT must never set this.
     */
    placeholder: z.boolean(),
    params: z.array(MogrtParamDefSchema).min(1),
  })
  .check((ctx) => {
    const { params } = ctx.value;
    params.forEach((param, position) => {
      if (param.index !== position) {
        ctx.issues.push({
          code: "custom",
          input: param.index,
          path: ["params", position, "index"],
          message: `params must be listed in index order; expected index ${position}, got ${param.index}`,
        });
      }
    });
    const names = new Set<string>();
    for (const param of params) {
      if (names.has(param.name)) {
        ctx.issues.push({
          code: "custom",
          input: param.name,
          path: ["params"],
          message: `duplicate param name "${param.name}"`,
        });
      }
      names.add(param.name);
    }
  });

export type MogrtParamType = z.infer<typeof MogrtParamTypeSchema>;
export type MogrtParamDefJson = z.infer<typeof MogrtParamDefSchema>;
export type MogrtDefinition = z.infer<typeof MogrtDefinitionSchema>;
