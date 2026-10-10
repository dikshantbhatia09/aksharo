import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import opentype from "opentype.js";

import { FONT_ERRORS, MAX_FONT_UPLOAD_BYTES } from "./fonts.constants.js";
import { AppException } from "../common/index.js";

export interface FontValidationResult {
  readonly valid: true;
  readonly family: string;
  readonly subfamily: string;
  readonly postScriptName: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly glyphCount: number;
  readonly unitsPerEm: number;
  readonly format: "truetype" | "opentype" | "woff2";
}

/**
 * Converts a Node.js Buffer, Uint8Array or ArrayBuffer into an ArrayBuffer
 * suitable for opentype.js.
 */
function toArrayBuffer(buffer: Buffer | Uint8Array | ArrayBuffer): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  const slice = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return slice as ArrayBuffer;
}

/**
 * Extracts a localized or English string name from opentype.Font.names.
 */
function extractFontName(font: opentype.Font, key: string): string {
  if (typeof font.getEnglishName === "function") {
    try {
      const name = font.getEnglishName(key);
      if (name && typeof name === "string") return name.trim();
    } catch {
      // Fallback to manual inspection
    }
  }

  const names = font.names as unknown as Record<string, unknown> | undefined;
  if (!names) return "";

  const direct = names[key];
  if (typeof direct === "string") return direct.trim();
  if (direct && typeof (direct as { en?: string }).en === "string") {
    return (direct as { en: string }).en.trim();
  }

  for (const platform of ["windows", "macintosh", "unicode"]) {
    const table = names[platform] as Record<string, unknown> | undefined;
    if (table && table[key]) {
      const val = table[key];
      if (typeof val === "string") return val.trim();
      if (typeof (val as { en?: string })?.en === "string") {
        return (val as { en: string }).en.trim();
      }
      const values = Object.values(val as Record<string, unknown>);
      if (values.length > 0 && typeof values[0] === "string") {
        return values[0].trim();
      }
    }
  }

  return "";
}

/**
 * Determines weight from OS/2 table or subfamily string.
 */
function extractFontWeight(font: opentype.Font, subfamily: string): number {
  const os2Weight = font.tables?.os2?.usWeightClass;
  if (typeof os2Weight === "number" && os2Weight >= 100 && os2Weight <= 900) {
    return Math.round(os2Weight / 100) * 100;
  }

  const lower = subfamily.toLowerCase();
  if (lower.includes("thin") || lower.includes("hairline")) return 100;
  if (lower.includes("extra light") || lower.includes("ultra light")) return 200;
  if (lower.includes("light")) return 300;
  if (lower.includes("medium")) return 500;
  if (lower.includes("semi bold") || lower.includes("demi bold")) return 600;
  if (lower.includes("extra bold") || lower.includes("ultra bold")) return 800;
  if (lower.includes("bold")) return 700;
  if (lower.includes("black") || lower.includes("heavy")) return 900;

  return 400;
}

/**
 * Detects format: woff2, opentype (CFF/OTTO), or truetype.
 */
function detectFormat(raw: Uint8Array, font: opentype.Font): "truetype" | "opentype" | "woff2" {
  if (raw.length >= 4) {
    const tag = String.fromCharCode(raw[0]!, raw[1]!, raw[2]!, raw[3]!);
    if (tag === "wOF2") return "woff2";
    if (tag === "OTTO") return "opentype";
  }
  if (font.tables?.cff || (font.tables as Record<string, unknown>)?.CFF) {
    return "opentype";
  }
  return "truetype";
}

/**
 * FontValidatorService (Feature 04-07: Custom Typography Engine)
 * Sanitizes and validates font binaries using opentype.js table verification.
 */
@Injectable()
export class FontValidatorService {
  private readonly logger = new Logger(FontValidatorService.name);

  /**
   * Validates an uploaded font buffer:
   * 1. Checks file size bounds (not empty, <= MAX_FONT_UPLOAD_BYTES).
   * 2. Parses OpenType headers and binary tables.
   * 3. Verifies Unicode `cmap` table presence and integrity.
   * 4. Verifies `head` table and unitsPerEm limits.
   * 5. Verifies glyph count > 0.
   * 6. Extracts true font family, subfamily, weight, slant, glyphCount.
   */
  validate(buffer: Buffer | Uint8Array | ArrayBuffer): FontValidationResult {
    const uint8 =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer);

    if (uint8.length === 0) {
      throw new AppException(
        "fonts/empty",
        "Uploaded font file is empty (0 bytes).",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (uint8.length > MAX_FONT_UPLOAD_BYTES) {
      throw new AppException(
        FONT_ERRORS.tooLarge,
        `Font exceeds maximum upload limit of ${String(MAX_FONT_UPLOAD_BYTES)} bytes.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { sizeBytes: uint8.length, maxBytes: MAX_FONT_UPLOAD_BYTES },
      );
    }

    let font: opentype.Font;
    try {
      const arrayBuf = toArrayBuffer(uint8);
      font = opentype.parse(arrayBuf);
    } catch (error) {
      this.logger.warn(`Failed to parse font buffer with opentype.js: ${String(error)}`);
      throw new AppException(
        "fonts/unparsable",
        `Corrupted or invalid font binary: ${error instanceof Error ? error.message : String(error)}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 1. Unicode cmap table verification (Critical OpenType requirement)
    const cmapTable = font.tables?.cmap;
    if (!cmapTable) {
      throw new AppException(
        "fonts/missing_cmap",
        "The font lacks a required Unicode cmap (character map) table.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const glyphIndexMap = cmapTable.glyphIndexMap;
    const hasMappedGlyphs =
      glyphIndexMap !== undefined &&
      glyphIndexMap !== null &&
      Object.keys(glyphIndexMap).length > 0;

    if (!hasMappedGlyphs) {
      throw new AppException(
        "fonts/missing_cmap",
        "The font's Unicode cmap table does not contain valid character mappings.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 2. Head table & unitsPerEm verification
    const headTable = font.tables?.head;
    if (!headTable) {
      throw new AppException(
        "fonts/bad_metrics",
        "The font is missing the head table.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const unitsPerEm = font.unitsPerEm ?? headTable.unitsPerEm;
    if (typeof unitsPerEm !== "number" || unitsPerEm < 16 || unitsPerEm > 16384) {
      throw new AppException(
        "fonts/bad_metrics",
        `Font unitsPerEm (${String(unitsPerEm)}) is outside the valid range [16, 16384].`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { unitsPerEm },
      );
    }

    // 3. Glyphs check
    const glyphCount = font.glyphs?.length ?? 0;
    if (glyphCount === 0) {
      throw new AppException(
        "fonts/no_outlines",
        "The font contains no outline glyphs.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 4. Extract typography metadata
    const family = extractFontName(font, "fontFamily") || "CustomFont";
    const subfamily = extractFontName(font, "fontSubfamily") || "Regular";
    const postScriptName = extractFontName(font, "postScriptName") || `${family}-${subfamily}`;
    const weight = extractFontWeight(font, subfamily);

    const os2Selection = font.tables?.os2?.fsSelection;
    const isItalic = Boolean(
      (typeof os2Selection === "number" && (os2Selection & 1) !== 0) ||
        /italic|oblique/i.test(subfamily),
    );

    const format = detectFormat(uint8, font);

    return {
      valid: true,
      family,
      subfamily,
      postScriptName,
      weight,
      italic: isItalic,
      glyphCount,
      unitsPerEm,
      format,
    };
  }
}
