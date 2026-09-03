/**
 * Where the render node gets its faces.
 *
 * Decision D33 forbids system fonts everywhere, so a face must arrive as bytes
 * this process registered. There are two sources, in order:
 *
 * 1. **A font pack on disk** (`RENDER_FONT_DIR`), which is what the deployed
 *    image mounts: a directory of `.ttf`/`.otf` files plus a `fonts.json` that
 *    names each one's family, weight, slant and scripts. A18b fills that
 *    directory from R2's `ws/{workspaceId}/fonts/` prefix; the schema here is the
 *    contract it will write against.
 * 2. **The three OFL subsets bundled with `@montaj/render-core`**, used when no
 *    pack is configured. They are enough for the fixtures and the parity suite
 *    and are announced with a warning, because a production render that falls
 *    back to them draws the right layout in the wrong typeface.
 *
 * A missing face is never a silent substitution: `render-core`'s registry
 * resolves family → the style's fallbacks → any face covering the script → any
 * face covering the code points, and reports what it could not find.
 */

import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { z } from "zod";

import { createFontRegistry, type FontRegistry, type FontResource } from "@montaj/render-core";
import { loadFixtureFonts } from "@montaj/render-core/testing";

/** One entry of a font pack's `fonts.json`. */
export const FontPackEntrySchema = z.object({
  id: z.string().min(1).max(128),
  family: z.string().min(1).max(128),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean().default(false),
  file: z.string().min(1).max(256),
  scripts: z.array(z.string().min(1).max(32)).optional(),
});

export const FontPackSchema = z.object({
  v: z.literal(1),
  fonts: z.array(FontPackEntrySchema).min(1),
});

export type FontPack = z.infer<typeof FontPackSchema>;

export const FONT_PACK_MANIFEST = "fonts.json";

export class FontPackError extends Error {
  public override readonly name = "FontPackError";
  constructor(
    readonly code: "render/bad-font-pack" | "render/font-file-missing",
    message: string,
  ) {
    super(message);
  }
}

export interface LoadedFonts {
  readonly registry: FontRegistry;
  readonly fonts: readonly FontResource[];
  /** `"pack"` or `"fixtures"`, so the log says which typefaces were drawn. */
  readonly source: "pack" | "fixtures";
  readonly directory: string | null;
}

/** Reads a font pack directory into `FontResource[]`. */
export async function readFontPack(directory: string): Promise<FontResource[]> {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    raw = await readFile(join(directory, FONT_PACK_MANIFEST), "utf8");
  } catch (error) {
    throw new FontPackError(
      "render/bad-font-pack",
      `${directory} has no ${FONT_PACK_MANIFEST}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: FontPack;
  try {
    parsed = FontPackSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new FontPackError(
      "render/bad-font-pack",
      `${join(directory, FONT_PACK_MANIFEST)} is not a v1 font pack: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const fonts: FontResource[] = [];
  for (const entry of parsed.fonts) {
    if (entry.file.includes("..") || entry.file.includes("/") || entry.file.includes("\\")) {
      throw new FontPackError(
        "render/bad-font-pack",
        `font file ${JSON.stringify(entry.file)} must be a bare name inside the pack directory`,
      );
    }
    if (![".ttf", ".otf"].includes(extname(entry.file).toLowerCase())) {
      throw new FontPackError(
        "render/bad-font-pack",
        `font file ${JSON.stringify(entry.file)} must be a .ttf or .otf; HarfBuzz reads neither woff nor woff2`,
      );
    }
    let data: Uint8Array;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      data = new Uint8Array(await readFile(join(directory, entry.file)));
    } catch (error) {
      throw new FontPackError(
        "render/font-file-missing",
        `${entry.file} is named by ${FONT_PACK_MANIFEST} but could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    fonts.push({
      id: entry.id,
      family: entry.family,
      weight: entry.weight,
      italic: entry.italic,
      data,
      ...(entry.scripts === undefined ? {} : { scripts: entry.scripts as FontResource["scripts"] }),
    });
  }
  return fonts;
}

/** Every `.ttf`/`.otf` in a directory, for the "is this a pack at all" check. */
export async function fontFilesIn(directory: string): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const entries = await readdir(directory);
  return entries.filter((name) => [".ttf", ".otf"].includes(extname(name).toLowerCase()));
}

export interface LoadFontsOptions {
  /** `RENDER_FONT_DIR`; `undefined` falls back to the bundled subsets. */
  readonly directory?: string | undefined;
  readonly onWarning?: (message: string) => void;
}

/** Builds the registry a render draws with. */
export async function loadFonts(options: LoadFontsOptions = {}): Promise<LoadedFonts> {
  if (options.directory !== undefined && options.directory !== "") {
    const fonts = await readFontPack(options.directory);
    return {
      registry: createFontRegistry(fonts),
      fonts,
      source: "pack",
      directory: options.directory,
    };
  }
  options.onWarning?.(
    "RENDER_FONT_DIR is not set: falling back to the three OFL subsets bundled with " +
      "@montaj/render-core. Layout will be correct and the typefaces will not be.",
  );
  const fonts = loadFixtureFonts();
  return { registry: createFontRegistry(fonts), fonts, source: "fixtures", directory: null };
}
