/**
 * The uploaded-font pipeline: bytes in, a manifest entry and two objects out.
 *
 * ```
 * validate -> decide the scripts -> instance and subset -> woff2 -> checksum
 * ```
 *
 * It is a pure function of its input — no database, no object store, no queue —
 * so the API can run it inline on `complete` and a future `media.font` worker
 * can run the identical code from a job payload without either of them having a
 * second implementation to keep honest. Everything that touches storage lives in
 * `apps/api/src/fonts`.
 *
 * The original bytes are returned alongside the subset, because the two
 * renderers want different things: the cloud renderer bakes whole faces into an
 * image and never pays a download, while the browser fetches per project and
 * cares about every kilobyte. Keeping the original also means a font whose
 * `fsType` forbids subsetting can still be served — as itself, whole.
 */

import { createHash } from "node:crypto";

import type { WordScript } from "@montaj/render-core";

import { toWordScripts, type ScriptTag } from "./scripts.js";
import { subsetFace } from "./subset.js";
import { validateFont, type FontValidation, type ValidateOptions } from "./validate.js";

export interface ProcessFontInput {
  readonly bytes: Uint8Array;
  /**
   * Scripts the uploader declared. Each is checked against the font's own
   * character map; when omitted, the scripts the font actually covers are used.
   */
  readonly claimedScripts?: readonly ScriptTag[];
  /** Extra characters to keep in the subset (a workspace's glossary, later). */
  readonly extraText?: string;
  readonly maxBytes?: number;
}

export interface ProcessedFont {
  readonly validation: FontValidation;
  /** The scripts the subset was cut for. */
  readonly scripts: readonly ScriptTag[];
  /** `WordScript` hints for `FontRegistry`. */
  readonly wordScripts: readonly WordScript[];
  /** The subset SFNT, or the original when the font forbids subsetting. */
  readonly sfnt: Uint8Array;
  readonly woff2: Uint8Array;
  readonly sha256Original: string;
  readonly sha256Sfnt: string;
  readonly sha256Woff2: string;
  /** False when `fsType.noSubsetting` made us ship the whole face. */
  readonly subset: boolean;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate, subset and compress one uploaded font.
 *
 * @throws FontValidationError when the font is refused (T7)
 * @throws FontSubsetError when `hb-subset` cannot produce a subset
 */
export async function processFont(input: ProcessFontInput): Promise<ProcessedFont> {
  const validateOptions: ValidateOptions = {
    ...(input.claimedScripts === undefined ? {} : { claimedScripts: input.claimedScripts }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  };
  const validation = validateFont(input.bytes, validateOptions);

  // The declared scripts win when they are given — they are what the subset is
  // cut to and what the manifest advertises — and the font's own coverage is the
  // fallback, so an uploader who declares nothing still gets a usable face.
  const scripts: readonly ScriptTag[] =
    input.claimedScripts !== undefined && input.claimedScripts.length > 0
      ? input.claimedScripts
      : validation.scripts;

  // A variable font is instanced to the weight its OS/2 table declares, so the
  // face a renderer registers has no axes left to disagree about.
  const axes = variationInstance(validation);

  const { sfnt, woff2 } = await subsetFace(input.bytes, {
    scripts,
    ...(axes === undefined ? {} : { axes }),
    ...(input.extraText === undefined ? {} : { extraText: input.extraText }),
  });

  return {
    validation,
    scripts,
    wordScripts: toWordScripts(scripts),
    sfnt,
    woff2,
    sha256Original: sha256(input.bytes),
    sha256Sfnt: sha256(sfnt),
    sha256Woff2: sha256(woff2),
    subset: true,
  };
}

/**
 * The axis pin for a variable upload, or `undefined` for a static face.
 *
 * `wght` is taken from OS/2's own weight class rather than from the axis
 * default, because a variable font's default instance and its declared weight
 * are allowed to differ — and the weight class is what the registry will match
 * the style against, so those two must agree or the face answers a query it does
 * not look like. Every other axis is pinned at its default.
 */
export function variationInstance(validation: FontValidation): Record<string, number> | undefined {
  if (!validation.variable) return undefined;
  const axes: Record<string, number> = {};
  if (validation.variationAxes.includes("wght")) axes["wght"] = validation.weight;
  if (validation.variationAxes.includes("wdth")) axes["wdth"] = 100;
  if (validation.variationAxes.includes("ital")) axes["ital"] = validation.italic ? 1 : 0;
  if (validation.variationAxes.includes("slnt")) axes["slnt"] = 0;
  return Object.keys(axes).length === 0 ? undefined : axes;
}
