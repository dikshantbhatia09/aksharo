import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FontValidatorService } from "./font-validator.service.js";
import { MAX_FONT_UPLOAD_BYTES } from "./fonts.constants.js";
import { AppException } from "../common/index.js";

describe("FontValidatorService", () => {
  const service = new FontValidatorService();

  // Load sample Anton TTF font from repo
  const sampleFontPath = resolve(
    __dirname,
    "../../../../packages/fonts/.cache/anton__Anton-Regular.ttf",
  );
  let sampleFontBuffer: Buffer;
  try {
    sampleFontBuffer = readFileSync(sampleFontPath);
  } catch {
    // If not found in .cache, try fixtures in render-core
    const fallbackPath = resolve(
      __dirname,
      "../../../../packages/render-core/testing/fixtures/inter-regular.ttf",
    );
    sampleFontBuffer = readFileSync(fallbackPath);
  }

  it("validates a genuine OpenType/TrueType font and extracts metadata", () => {
    const result = service.validate(sampleFontBuffer);

    expect(result.valid).toBe(true);
    expect(result.family.length).toBeGreaterThan(0);
    expect(result.subfamily.length).toBeGreaterThan(0);
    expect(result.glyphCount).toBeGreaterThan(0);
    expect(result.weight).toBeGreaterThanOrEqual(100);
    expect(result.weight).toBeLessThanOrEqual(900);
    expect(result.unitsPerEm).toBeGreaterThan(0);
    expect(["truetype", "opentype", "woff2"]).toContain(result.format);
  });

  it("rejects an empty buffer with fonts/empty", () => {
    expect(() => service.validate(Buffer.alloc(0))).toThrow(AppException);
    try {
      service.validate(Buffer.alloc(0));
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe("fonts/empty");
    }
  });

  it("rejects corrupted binary data with fonts/unparsable", () => {
    const corruptBuffer = Buffer.from("NOT_A_VALID_FONT_DATA_JUST_GARBAGE_BYTES_123456789");
    expect(() => service.validate(corruptBuffer)).toThrow(AppException);
    try {
      service.validate(corruptBuffer);
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe("fonts/unparsable");
    }
  });

  it("rejects files exceeding MAX_FONT_UPLOAD_BYTES with payload too large", () => {
    const oversizedBuffer = Buffer.alloc(MAX_FONT_UPLOAD_BYTES + 1024);
    expect(() => service.validate(oversizedBuffer)).toThrow(AppException);
    try {
      service.validate(oversizedBuffer);
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).status).toBe(413);
    }
  });
});

