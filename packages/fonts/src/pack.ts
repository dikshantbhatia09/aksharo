/**
 * The bundled pack on disk, and the Node/cloud `FontRegistry` loader.
 *
 * The pack is a directory of `.ttf` and `.woff2` files plus the `fonts.json`
 * manifest, committed under `packages/fonts/pack/` and copied into the render
 * image. `apps/render` reads it through `RENDER_FONT_DIR`; the API serves the
 * same manifest and the same bytes to the browser. One directory, one manifest,
 * two consumers — which is the only way the cloud and the browser can be shown
 * to draw the same typeface.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createFontRegistry, type FontRegistry, type FontResource } from "@montaj/render-core";

import { LICENCE_DIR, MANIFEST_FILE, parseManifest, type FontManifest } from "./manifest.js";

/**
 * `packages/fonts/pack`, resolved from the sources and from `dist/` alike.
 *
 * `__dirname` is `src/` under tsx and vitest, `dist/` after a build and
 * `dist/esm/` in the ESM output, so the pack sits one, one and two levels up.
 * The first candidate that has a manifest in it wins; a package installed
 * without its `pack` directory answers with the conventional path so the caller
 * gets a "no such file" naming the place it should have been.
 */
export function bundledPackDirectory(): string {
  const candidates = [
    join(__dirname, "..", "pack"),
    join(__dirname, "..", "..", "pack"),
    join(__dirname, "pack"),
  ];
  for (const candidate of candidates) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    if (existsSync(join(candidate, MANIFEST_FILE))) return candidate;
  }
  return candidates[0] ?? join(__dirname, "..", "pack");
}

export function packManifestPath(directory = bundledPackDirectory()): string {
  return join(directory, MANIFEST_FILE);
}

export function packLicencePath(file: string, directory = bundledPackDirectory()): string {
  return join(directory, LICENCE_DIR, file);
}

/** Read and validate a pack's `fonts.json`. */
export async function readPackManifest(directory = bundledPackDirectory()): Promise<FontManifest> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const raw = await readFile(packManifestPath(directory), "utf8");
  return parseManifest(JSON.parse(raw), packManifestPath(directory));
}

export interface LoadedPack {
  readonly manifest: FontManifest;
  readonly registry: FontRegistry;
  readonly fonts: readonly FontResource[];
  readonly directory: string;
}

export class FontPackIntegrityError extends Error {
  public override readonly name = "FontPackIntegrityError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Load a pack directory into a `FontRegistry`.
 *
 * `verify` re-computes each face's SHA-256 and refuses a mismatch. It is off by
 * default because a render node loading forty faces per boot should not hash
 * eight megabytes every time; the pack test turns it on, which is where a
 * corrupted or hand-edited pack gets caught.
 */
export async function loadPack(
  options: { readonly directory?: string; readonly verify?: boolean } = {},
): Promise<LoadedPack> {
  const directory = options.directory ?? bundledPackDirectory();
  const manifest = await readPackManifest(directory);
  const fonts: FontResource[] = [];

  for (const face of manifest.fonts) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const data = new Uint8Array(await readFile(join(directory, face.file)));
    if (options.verify === true) {
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== face.sha256) {
        throw new FontPackIntegrityError(
          `${face.file} hashes to ${digest}, but ${MANIFEST_FILE} says ${face.sha256}`,
        );
      }
    }
    fonts.push({
      id: face.id,
      family: face.family,
      weight: face.weight,
      italic: face.italic,
      data,
      scripts: face.scripts,
    });
  }

  return { manifest, registry: createFontRegistry(fonts), fonts, directory };
}

/**
 * Register a manifest's faces into an existing registry, fetching the bytes.
 *
 * This is the cloud renderer's path for a *workspace's* fonts: the manifest
 * comes from `GET /workspaces/{id}/fonts` with signed URLs on it, and the bytes
 * are fetched over HTTP rather than read from the image. Bundled faces come off
 * disk through {@link loadPack}; a project that uses a custom font adds it here.
 */
export async function registerManifestFonts(
  registry: FontRegistry,
  manifest: FontManifest,
  options: {
    readonly fetchBytes: (face: FontManifest["fonts"][number]) => Promise<Uint8Array>;
    readonly onWarning?: (message: string) => void;
  },
): Promise<FontResource[]> {
  const registered: FontResource[] = [];
  for (const face of manifest.fonts) {
    try {
      const data = await options.fetchBytes(face);
      const resource: FontResource = {
        id: face.id,
        family: face.family,
        weight: face.weight,
        italic: face.italic,
        data,
        scripts: face.scripts,
      };
      registry.register(resource);
      registered.push(resource);
    } catch (error) {
      // One unavailable custom font must not stop a render: the registry falls
      // back to a face that covers the code points, which is a wrong typeface
      // rather than no video. It is warned about loudly for exactly that reason.
      options.onWarning?.(
        `could not register ${face.family} (${face.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return registered;
}
