import { z } from "zod";

import { StyleDocSchema } from "@montaj/caption-styles";

import { zodDto } from "../common/index.js";

/**
 * Request and response schemas for the style catalogue (07 §Styles, D64).
 *
 * `doc` is always the full `StyleDoc` v2 document: the D64 naming rule and every
 * structural constraint (typography, colours, animation, ...) live in that one
 * schema (`@montaj/caption-styles`), so a request that fails it fails validation
 * before this module's own code ever runs.
 */

export const createStylePresetSchema = z.object({
  doc: StyleDocSchema,
});

export class CreateStylePresetDto extends zodDto(createStylePresetSchema) {}

/**
 * A preset's `key` (`doc.id`) is immutable once created — changing it is a new
 * style, not an edit, because `styleRef` values elsewhere point at the key, not
 * at the row id.
 */
export const updateStylePresetSchema = z.object({
  doc: StyleDocSchema,
});

export class UpdateStylePresetDto extends zodDto(updateStylePresetSchema) {}

// --- Response shapes (documentation only; the service builds the objects) ----

/**
 * One catalogue entry: the `StyleDoc` fields a component reads (unchanged from
 * the bundled fallback, `system-styles.ts` promises), plus where it came from.
 */
export const styleCatalogueEntrySchema = z
  .looseObject({
    id: z.string(),
    name: z.string(),
    version: z.literal(2),
    category: z.string(),
    minPlan: z.string(),
  })
  .extend({
    /** The `style_presets` row id — never the same as `id` (the catalogue key). */
    presetId: z.string(),
    source: z.enum(["system", "custom"]),
    /** `null` for a system style. */
    workspaceId: z.string().nullable(),
    /**
     * Filename under `packages/caption-styles/previews/`, copied to the web
     * app's own `/style-previews/` at build time. `null` when no static preview
     * has been rendered for this style yet (every custom preset, until someone
     * generates one).
     */
    previewKey: z.string().nullable(),
  });

export const stylePageSchema = z.array(styleCatalogueEntrySchema);
