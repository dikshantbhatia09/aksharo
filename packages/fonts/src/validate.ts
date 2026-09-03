/**
 * Font validation — the gate an uploaded font passes before anything else looks
 * at it (THREAT-MODEL T7, F-305).
 *
 * The rules are ordered cheapest-first and each one answers with a `fonts/*`
 * code the API hands straight to the client:
 *
 * | Code                             | Refused because                                  |
 * | -------------------------------- | ------------------------------------------------ |
 * | `fonts/too_large`                | over {@link MAX_FONT_BYTES}                      |
 * | `fonts/empty`                    | no bytes at all                                  |
 * | `fonts/unknown_format`           | not an sfnt, WOFF or WOFF2 signature             |
 * | `fonts/unparsable`               | an OpenType parser could not read it             |
 * | `fonts/collection_unsupported`   | a `.ttc` collection: which face did you mean?    |
 * | `fonts/no_outlines`              | bitmap-only, or an outline table we cannot draw  |
 * | `fonts/embedding_restricted`     | `OS/2.fsType` forbids embedding                  |
 * | `fonts/too_many_glyphs`          | a glyph count no caption font has                |
 * | `fonts/script_not_covered`       | claims a script its character map does not cover |
 * | `fonts/no_supported_script`      | covers none of the scripts we can subset for     |
 * | `fonts/bad_metrics`              | `unitsPerEm` outside the sane range              |
 *
 * Two of these are worth their existence being spelled out.
 *
 * **`fsType`.** The OS/2 table's embedding bits are the type designer's own
 * machine-readable licence statement. A font marked "no embedding" or "bitmap
 * embedding only" cannot legally be baked into a rendered video, whatever the
 * uploader attests, so it is refused before the attestation is even recorded —
 * the attestation is a warranty about a right the uploader might have, and this
 * is the one case where the file itself says they do not.
 *
 * **Script claims.** The uploader says which scripts their font is for and the
 * subsetter is about to throw away everything else. If the claim is wrong, the
 * subset keeps nothing and the caption silently falls back to a Noto face. So a
 * claim is checked against the font's own character map before subsetting, not
 * after: {@link COVERAGE_THRESHOLD} of the script's required repertoire has to
 * be there.
 */

import * as fontkit from "fontkit";

import {
  COVERAGE_THRESHOLD,
  coverageRatio,
  coveredScripts,
  isScriptTag,
  SCRIPT_NAMES,
  type ScriptTag,
} from "./scripts.js";

import type { FontkitFont, FontkitFsType } from "fontkit";

/**
 * The largest font we accept, 8 MiB.
 *
 * A full CJK face is 15–20 MB and a Latin or Indic face is 100–800 kB, so 8 MiB
 * is comfortably above anything a creator uploads for captions and comfortably
 * below anything that would make the subsetter a denial-of-service target. The
 * presigned PUT is signed for this size, so a larger body is refused by the
 * store as well as here.
 */
export const MAX_FONT_BYTES = 8 * 1024 * 1024;

/** A glyph count past which the file is not a caption font. */
export const MAX_GLYPHS = 65_535;

/** `unitsPerEm` must be a sane power-of-two-ish value; 16..16384 per the spec. */
export const MIN_UPEM = 16;
export const MAX_UPEM = 16_384;

export type FontValidationCode =
  | "fonts/too_large"
  | "fonts/empty"
  | "fonts/unknown_format"
  | "fonts/unparsable"
  | "fonts/collection_unsupported"
  | "fonts/no_outlines"
  | "fonts/embedding_restricted"
  | "fonts/too_many_glyphs"
  | "fonts/script_not_covered"
  | "fonts/no_supported_script"
  | "fonts/bad_metrics";

/** Refusal. `code` reaches the client; `details` are machine-readable context. */
export class FontValidationError extends Error {
  public override readonly name = "FontValidationError";
  constructor(
    readonly code: FontValidationCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

/** What the file turned out to be. */
export interface FontValidation {
  readonly family: string;
  readonly subfamily: string;
  readonly postscriptName: string | null;
  readonly weight: number;
  readonly italic: boolean;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly numGlyphs: number;
  readonly sizeBytes: number;
  /** `ttf`, `otf`, `woff` or `woff2`, from the signature. */
  readonly format: FontContainer;
  /** Scripts the character map actually covers, by our own threshold. */
  readonly scripts: readonly ScriptTag[];
  /** Coverage of every script, for the diagnostic in a refusal. */
  readonly coverage: Readonly<Record<string, number>>;
  /** Variation axes, empty for a static face. */
  readonly variationAxes: readonly string[];
  /** True when the font is variable and would need instancing. */
  readonly variable: boolean;
  /** Code points the face can draw. */
  readonly codePoints: ReadonlySet<number>;
}

export type FontContainer = "ttf" | "otf" | "woff" | "woff2";

/** The container a font's first four bytes declare, or `undefined`. */
export function detectContainer(bytes: Uint8Array): FontContainer | undefined {
  if (bytes.byteLength < 4) return undefined;
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || tag === "ttcf") return tag === "ttcf" ? undefined : "ttf";
  const version =
    (bytes[0] ?? 0) * 0x1000000 +
    (bytes[1] ?? 0) * 0x10000 +
    (bytes[2] ?? 0) * 0x100 +
    (bytes[3] ?? 0);
  if (version === 0x00010000) return "ttf";
  return undefined;
}

/** True for the four bytes of a TrueType collection, which we refuse by name. */
export function isCollection(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "ttcf";
}

/**
 * Embedding permission, from the OS/2 table.
 *
 * `noEmbedding` and `bitmapOnly` are refusals; `viewOnly` (preview and print
 * only) is a refusal too, because rendering a caption into a video file is
 * neither previewing nor printing. `noSubsetting` is *not* a refusal on its own
 * — it forbids shipping a subset, so such a font is kept whole instead.
 */
export function embeddingVerdict(fsType: FontkitFsType | undefined): {
  readonly allowed: boolean;
  readonly mayBeSubset: boolean;
  readonly reason?: string;
} {
  if (fsType === undefined) return { allowed: true, mayBeSubset: true };
  if (fsType.noEmbedding === true) {
    return { allowed: false, mayBeSubset: false, reason: "the font forbids embedding" };
  }
  if (fsType.bitmapOnly === true) {
    return { allowed: false, mayBeSubset: false, reason: "the font allows bitmap embedding only" };
  }
  if (fsType.viewOnly === true) {
    return {
      allowed: false,
      mayBeSubset: false,
      reason: "the font is licensed for preview and print only",
    };
  }
  return { allowed: true, mayBeSubset: fsType.noSubsetting !== true };
}

export interface ValidateOptions {
  /** Scripts the uploader says the font is for; each one is checked. */
  readonly claimedScripts?: readonly string[];
  /** Override the size cap (the API passes the plan's, tests pass a small one). */
  readonly maxBytes?: number;
}

/**
 * Parse and judge a font.
 *
 * @throws FontValidationError with a `fonts/*` code for every refusal.
 */
export function validateFont(bytes: Uint8Array, options: ValidateOptions = {}): FontValidation {
  const maxBytes = options.maxBytes ?? MAX_FONT_BYTES;
  if (bytes.byteLength === 0) {
    throw new FontValidationError("fonts/empty", "the upload has no bytes");
  }
  if (bytes.byteLength > maxBytes) {
    throw new FontValidationError(
      "fonts/too_large",
      `the font is ${String(bytes.byteLength)} bytes; the limit is ${String(maxBytes)}`,
      { sizeBytes: bytes.byteLength, maxBytes },
    );
  }
  if (isCollection(bytes)) {
    throw new FontValidationError(
      "fonts/collection_unsupported",
      "TrueType collections carry several faces; upload the single face you want",
    );
  }
  const format = detectContainer(bytes);
  if (format === undefined) {
    throw new FontValidationError(
      "fonts/unknown_format",
      "the file does not start with a TrueType, OpenType, WOFF or WOFF2 signature",
    );
  }

  let face: FontkitFont;
  try {
    face = fontkit.create(Buffer.from(bytes));
  } catch (error) {
    throw new FontValidationError(
      "fonts/unparsable",
      `an OpenType parser refused the file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Array.isArray(face.fonts)) {
    throw new FontValidationError(
      "fonts/collection_unsupported",
      "the file is a font collection; upload the single face you want",
    );
  }

  const unitsPerEm = face.unitsPerEm ?? 0;
  if (!Number.isFinite(unitsPerEm) || unitsPerEm < MIN_UPEM || unitsPerEm > MAX_UPEM) {
    throw new FontValidationError(
      "fonts/bad_metrics",
      `unitsPerEm is ${String(unitsPerEm)}; a usable face is between ${String(MIN_UPEM)} and ${String(MAX_UPEM)}`,
      { unitsPerEm },
    );
  }

  const numGlyphs = face.numGlyphs ?? 0;
  if (numGlyphs <= 0) {
    throw new FontValidationError(
      "fonts/no_outlines",
      "the font declares no glyphs; a bitmap-only or stripped file cannot be rendered",
    );
  }
  if (numGlyphs > MAX_GLYPHS) {
    throw new FontValidationError(
      "fonts/too_many_glyphs",
      `the font declares ${String(numGlyphs)} glyphs, past the ${String(MAX_GLYPHS)} a caption font can have`,
      { numGlyphs },
    );
  }

  const embedding = embeddingVerdict(face["OS/2"]?.fsType);
  if (!embedding.allowed) {
    throw new FontValidationError(
      "fonts/embedding_restricted",
      `${embedding.reason ?? "the font forbids embedding"} (OS/2 fsType), so it cannot be burned into a video`,
      { fsType: face["OS/2"]?.fsType },
    );
  }

  const codePoints = new Set<number>(face.characterSet ?? []);
  const scripts = coveredScripts(codePoints);
  const coverage: Record<string, number> = {};
  for (const [tag, name] of Object.entries(SCRIPT_NAMES)) {
    void name;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (isScriptTag(tag)) coverage[tag] = Number(coverageRatio(tag, codePoints).toFixed(3));
  }

  for (const claim of options.claimedScripts ?? []) {
    if (!isScriptTag(claim)) {
      throw new FontValidationError(
        "fonts/script_not_covered",
        `${JSON.stringify(claim)} is not a script this catalogue knows`,
        { claimed: claim },
      );
    }
    const ratio = coverageRatio(claim, codePoints);
    if (ratio < COVERAGE_THRESHOLD) {
      throw new FontValidationError(
        "fonts/script_not_covered",
        // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
        `the font claims ${SCRIPT_NAMES[claim]} but covers only ${(ratio * 100).toFixed(0)}% of it`,
        { claimed: claim, coverage: Number(ratio.toFixed(3)), required: COVERAGE_THRESHOLD },
      );
    }
  }

  if (scripts.length === 0) {
    throw new FontValidationError(
      "fonts/no_supported_script",
      "the font covers none of the scripts Aksharo can subset for",
      { coverage },
    );
  }

  const axes = Object.keys(face.variationAxes ?? {});
  const weight = normaliseWeight(face["OS/2"]?.usWeightClass);

  return {
    family: (face.familyName ?? "").trim() || "Unnamed",
    subfamily: (face.subfamilyName ?? "Regular").trim(),
    postscriptName: face.postscriptName ?? null,
    weight,
    italic:
      face.head?.macStyle?.italic === true || /italic|oblique/i.test(face.subfamilyName ?? ""),
    unitsPerEm,
    ascent: face.ascent ?? 0,
    descent: face.descent ?? 0,
    lineGap: face.lineGap ?? 0,
    numGlyphs,
    sizeBytes: bytes.byteLength,
    format,
    scripts,
    coverage,
    variationAxes: axes,
    variable: axes.length > 0,
    codePoints,
  };
}

/**
 * OS/2 `usWeightClass` to a CSS weight.
 *
 * Old fonts store 1–9 rather than 100–900, and a few store nothing usable at
 * all; the registry compares weights numerically, so a 0 would make every face
 * look like the closest match to a hairline.
 */
export function normaliseWeight(usWeightClass: number | undefined): number {
  if (usWeightClass === undefined || !Number.isFinite(usWeightClass)) return 400;
  if (usWeightClass >= 1 && usWeightClass <= 9) return usWeightClass * 100;
  if (usWeightClass < 100) return 100;
  if (usWeightClass > 900) return 900;
  return Math.round(usWeightClass / 100) * 100;
}

/** May this validated face be shipped as a subset? (`fsType.noSubsetting`.) */
export function mayBeSubset(bytes: Uint8Array): boolean {
  try {
    const face = fontkit.create(Buffer.from(bytes));
    return embeddingVerdict(face["OS/2"]?.fsType).mayBeSubset;
  } catch {
    return false;
  }
}
