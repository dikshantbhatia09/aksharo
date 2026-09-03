import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  type StyleCategory,
  StyleCategorySchema,
  type StyleDoc,
  StyleDocSchema,
  StyleIdSchema,
} from "./schema.js";

/**
 * The system style catalogue: JSON documents under `styles/`, plus
 * `styles/registry.json` listing every planned style so the roadmap (30+ styles,
 * F-305) is visible before A16 has drawn them all.
 */

/** `styles/`, resolved from the compiled bundle and from the sources alike. */
export const STYLES_DIR = join(__dirname, "..", "styles");

/** The registry file, which is not itself a style. */
export const REGISTRY_FILENAME = "registry.json";

export const RegistryEntrySchema = z.object({
  id: StyleIdSchema,
  name: z.string().min(2).max(48),
  category: StyleCategorySchema,
  /** `shipped` means `styles/<id>.json` exists; `planned` is a roadmap slot. */
  status: z.enum(["planned", "shipped"]),
});

export const StyleRegistrySchema = z.object({
  version: z.literal(1),
  styles: z.array(RegistryEntrySchema).min(1),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type StyleRegistry = z.infer<typeof StyleRegistrySchema>;

/** Thrown when a catalogue file is missing or invalid. */
export class StyleCatalogueError extends Error {
  override readonly name = "StyleCatalogueError";
}

function readJson(path: string): unknown {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new StyleCatalogueError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

/** Parses and returns `styles/registry.json`. */
export function loadStyleRegistry(dir: string = STYLES_DIR): StyleRegistry {
  const path = join(dir, REGISTRY_FILENAME);
  const parsed = StyleRegistrySchema.safeParse(readJson(path));
  if (!parsed.success) {
    throw new StyleCatalogueError(`${REGISTRY_FILENAME} is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Loads and validates every shipped system style, ordered by id. A document that
 * fails the schema — including the naming rule (D64) — throws rather than being
 * skipped: a broken style must never reach the catalogue.
 */
export function loadSystemStyles(dir: string = STYLES_DIR): StyleDoc[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== REGISTRY_FILENAME)
    .sort();

  return files.map((file) => {
    const parsed = StyleDocSchema.safeParse(readJson(join(dir, file)));
    if (!parsed.success) {
      throw new StyleCatalogueError(`styles/${file} is invalid: ${parsed.error.message}`);
    }
    if (parsed.data.id !== file.replace(/\.json$/, "")) {
      throw new StyleCatalogueError(
        `styles/${file} declares id "${parsed.data.id}"; the file must be <id>.json`,
      );
    }
    return parsed.data;
  });
}

/** The shipped styles keyed by id. */
export function loadSystemStyleMap(dir: string = STYLES_DIR): Map<string, StyleDoc> {
  return new Map(loadSystemStyles(dir).map((style) => [style.id, style]));
}

/** Registry entries in one category, planned ones included. */
export function stylesInCategory(
  category: StyleCategory,
  dir: string = STYLES_DIR,
): RegistryEntry[] {
  return loadStyleRegistry(dir).styles.filter((entry) => entry.category === category);
}
