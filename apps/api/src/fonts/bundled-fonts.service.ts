import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CATALOGUE,
  SCHEDULED_LANGUAGES,
  SCRIPT_NAMES,
  summariseFamilies,
  type FontManifest,
  type ScriptTag,
} from "@montaj/fonts";
import { bundledPackDirectory, readPackManifest } from "@montaj/fonts/node";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { FONT_ERRORS } from "./fonts.constants.js";
import { AppException } from "../common/index.js";

/**
 * The bundled catalogue: the open-licence pack that ships with the product.
 *
 * These faces are the same for every workspace, are OFL or Apache licensed, and
 * are read off disk out of `@montaj/fonts`. Two consequences follow and both are
 * deliberate:
 *
 * - **the manifest is cached in this process, not in Redis.** It is a pure
 *   function of the deployed bytes, so two instances cannot disagree about it
 *   and a restart is the only thing that can change it;
 * - **the bytes are served unsigned.** A signed URL scopes an object to a
 *   tenant; an OFL font has no tenant, its licence expressly permits
 *   redistribution, and a CSS `@font-face` cannot send an `Authorization`
 *   header. The route that serves them is therefore `@Public()` and immutable
 *   cached. Workspace fonts are the opposite case and are signed per request.
 */
@Injectable()
export class BundledFontsService {
  private readonly logger = new Logger(BundledFontsService.name);
  private manifest: FontManifest | null = null;
  /** File name → the bytes' path, built from the manifest so nothing else serves. */
  private servable: Map<string, string> | null = null;

  /** The pack manifest, with `url`/`woff2Url` pointing at the public route. */
  async getManifest(): Promise<FontManifest> {
    const manifest = await this.load();
    return {
      ...manifest,
      fonts: manifest.fonts.map((face) => ({
        ...face,
        url: publicFontUrl(face.file),
        ...(face.woff2 === undefined ? {} : { woff2Url: publicFontUrl(face.woff2) }),
      })),
    };
  }

  /**
   * `GET /styles/fonts/catalog` — the picker's list (brief §5).
   *
   * A curated list of families with their script coverage, built from the same
   * manifest the renderer loads rather than from a second table, so a family
   * cannot appear in the picker without its bytes being in the image.
   */
  async getCatalogue(): Promise<{
    version: 1;
    families: {
      family: string;
      weights: number[];
      scripts: string[];
      scriptNames: string[];
      licence: string;
      licenceUrl: string;
      totalBytes: number;
      note: string;
    }[];
    languages: { code: string; name: string; script: string; scriptName: string }[];
  }> {
    const manifest = await this.load();
    const notes = new Map(CATALOGUE.map((family) => [family.family, family.note]));
    return {
      version: 1,
      families: summariseFamilies(manifest).map((family) => ({
        family: family.family,
        weights: [...family.weights],
        scripts: [...family.scriptTags],
        scriptNames: family.scriptTags.map((tag) => SCRIPT_NAMES[tag as ScriptTag] ?? tag),
        licence: family.licence ?? "OFL-1.1",
        licenceUrl: publicLicenceUrl(family.faces[0]?.licenceFile ?? ""),
        totalBytes: family.totalBytes,
        note: notes.get(family.family) ?? "",
      })),
      languages: SCHEDULED_LANGUAGES.map((language) => ({
        code: language.code,
        name: language.name,
        script: language.script,
        scriptName: SCRIPT_NAMES[language.script],
      })),
    };
  }

  /**
   * The bytes of one bundled file.
   *
   * The name is looked up in a map built from the manifest, so the only files
   * this route can ever read are the ones the manifest names — a path is never
   * built from the request (THREAT-MODEL T5). An unknown name is 404, not a
   * filesystem error.
   */
  async readFile(name: string): Promise<{ bytes: Buffer; contentType: string }> {
    await this.load();
    const path = this.servable?.get(name);
    if (path === undefined) {
      throw new AppException(
        FONT_ERRORS.unknownFile,
        "No such bundled font.",
        HttpStatus.NOT_FOUND,
        { file: name },
      );
    }
    return {
      bytes: await readFile(path),
      contentType: name.endsWith(".woff2")
        ? "font/woff2"
        : name.endsWith(".otf")
          ? "font/otf"
          : name.endsWith(".txt")
            ? "text/plain; charset=utf-8"
            : "font/ttf",
    };
  }

  /** Read and index the pack once per process. */
  private async load(): Promise<FontManifest> {
    if (this.manifest !== null) return this.manifest;
    const directory = bundledPackDirectory();
    let manifest: FontManifest;
    try {
      manifest = await readPackManifest(directory);
    } catch (error) {
      this.logger.error({ err: error, directory }, "the bundled font pack could not be read");
      throw new AppException(
        FONT_ERRORS.invalidState,
        "The bundled font catalogue is unavailable.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const servable = new Map<string, string>();
    for (const face of manifest.fonts) {
      servable.set(face.file, join(directory, face.file));
      if (face.woff2 !== undefined) servable.set(face.woff2, join(directory, face.woff2));
      if (face.licenceFile !== undefined) {
        servable.set(face.licenceFile, join(directory, "licences", face.licenceFile));
      }
    }
    this.manifest = manifest;
    this.servable = servable;
    this.logger.log({ faces: manifest.fonts.length, directory }, "bundled font catalogue loaded");
    return manifest;
  }
}

/** Where a bundled file is served from. Relative, so any origin works. */
export function publicFontUrl(file: string): string {
  return `/fonts/pack/${file}`;
}

export function publicLicenceUrl(file: string): string {
  return `/fonts/pack/${file}`;
}
