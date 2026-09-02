/**
 * The font manifest — one schema for the bundled pack and for a workspace's
 * uploaded fonts.
 *
 * It is a **superset of `apps/render`'s v1 font pack** (`FontPackSchema` in
 * `apps/render/src/render/fonts.ts`): the same `{ v: 1, fonts: [{ id, family,
 * weight, italic, file, scripts }] }`, with the extra fields the API, the
 * browser loader and the licence record need. Zod strips unknown keys, so the
 * render node parses a manifest written here without knowing about any of them,
 * and there is exactly one file rather than two that can disagree.
 *
 * `scripts` is the `WordScript` hint `FontRegistry` resolves by; `scriptTags`
 * is the ISO 15924 truth the catalogue and the coverage tests use. See
 * `scripts.ts` for why both exist.
 */

import { z } from "zod";

import { SCRIPT_TAGS } from "./scripts.js";

/** The licences a bundled family may be under. Nothing else is vendored. */
export const BUNDLED_LICENCES = ["OFL-1.1", "Apache-2.0"] as const;

export type BundledLicence = (typeof BUNDLED_LICENCES)[number];

/** `WordScript`, spelled as a Zod enum so the manifest can be validated. */
export const wordScriptSchema = z.enum(["latin", "devanagari", "tamil", "other"]);

export const scriptTagSchema = z.enum(SCRIPT_TAGS);

/** A bare file name inside the manifest's own directory — never a path. */
const fileNameSchema = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (name) => !name.includes("/") && !name.includes("\\") && !name.includes(".."),
    "a manifest names files in its own directory, never a path",
  );

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex digits");

/**
 * One face.
 *
 * The first six fields are the render pack contract, in its order. `file` is the
 * SFNT (`.ttf`/`.otf`) every shaper needs — HarfBuzz and CanvasKit both read
 * sfnt tables and neither reads WOFF2 — and `woff2` is the compressed twin the
 * browser fetches instead, roughly a third of the size.
 */
export const fontFaceSchema = z.object({
  id: z.string().min(1).max(128),
  family: z.string().min(1).max(128),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean().default(false),
  file: fileNameSchema,
  scripts: z.array(wordScriptSchema).min(1),

  /** ISO 15924 tags this face covers, checked against its own character map. */
  scriptTags: z.array(scriptTagSchema).min(1),
  /** The compressed twin, when the pack has one. */
  woff2: fileNameSchema.optional(),
  sizeBytes: z.number().int().nonnegative(),
  woff2SizeBytes: z.number().int().nonnegative().optional(),
  /** SHA-256 of the bytes in `file`, so a mirror can be checked. */
  sha256: sha256Schema,
  licence: z.enum(BUNDLED_LICENCES).optional(),
  /** File name of the licence text, inside the pack's `licences/` directory. */
  licenceFile: z.string().min(1).max(160).optional(),
  /** Where the upstream font came from, for the provenance record. */
  upstream: z
    .object({
      repo: z.string().min(1).max(128),
      ref: z.string().min(1).max(64),
      path: z.string().min(1).max(256),
    })
    .optional(),
  /** Absolute or app-relative URL for the bytes; the API fills this in. */
  url: z.string().min(1).max(2_048).optional(),
  woff2Url: z.string().min(1).max(2_048).optional(),
});

export type FontFace = z.infer<typeof fontFaceSchema>;

export const fontManifestSchema = z.object({
  v: z.literal(1),
  /** `bundled` for the shipped catalogue, `workspace` for uploaded fonts. */
  origin: z.enum(["bundled", "workspace"]).default("bundled"),
  generatedAt: z.string().min(1).max(64).optional(),
  fonts: z.array(fontFaceSchema).min(1),
});

export type FontManifest = z.infer<typeof fontManifestSchema>;

/** The file name the pack directory stores its manifest under (`fonts.json`). */
export const MANIFEST_FILE = "fonts.json";

/** Where the licence texts live inside a pack directory. */
export const LICENCE_DIR = "licences";

export class FontManifestError extends Error {
  public override readonly name = "FontManifestError";
  constructor(message: string) {
    super(message);
  }
}

/** Parse and validate a manifest, with a message that names the file. */
export function parseManifest(raw: unknown, source = MANIFEST_FILE): FontManifest {
  const result = fontManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new FontManifestError(`${source} is not a v1 font manifest: ${result.error.message}`);
  }
  const manifest = result.data;
  const ids = new Set<string>();
  for (const font of manifest.fonts) {
    if (ids.has(font.id)) {
      throw new FontManifestError(`${source} lists the face id ${JSON.stringify(font.id)} twice`);
    }
    ids.add(font.id);
  }
  return manifest;
}

/** Families in the manifest, each with its faces, in first-seen order. */
export interface FamilySummary {
  readonly family: string;
  readonly weights: readonly number[];
  readonly scriptTags: readonly string[];
  readonly licence: string | undefined;
  readonly faces: readonly FontFace[];
  readonly totalBytes: number;
}

export function summariseFamilies(manifest: FontManifest): FamilySummary[] {
  const order: string[] = [];
  const byFamily = new Map<string, FontFace[]>();
  for (const face of manifest.fonts) {
    const existing = byFamily.get(face.family);
    if (existing === undefined) {
      order.push(face.family);
      byFamily.set(face.family, [face]);
    } else {
      existing.push(face);
    }
  }
  return order.map((family) => {
    const faces = byFamily.get(family) ?? [];
    const tags = new Set<string>();
    for (const face of faces) for (const tag of face.scriptTags) tags.add(tag);
    return {
      family,
      weights: [...new Set(faces.map((face) => face.weight))].sort((a, b) => a - b),
      scriptTags: [...tags],
      licence: faces[0]?.licence,
      faces,
      totalBytes: faces.reduce((sum, face) => sum + face.sizeBytes, 0),
    };
  });
}

/** Every ISO 15924 tag any face in the manifest claims. */
export function manifestScriptTags(manifest: FontManifest): Set<string> {
  const tags = new Set<string>();
  for (const face of manifest.fonts) for (const tag of face.scriptTags) tags.add(tag);
  return tags;
}
