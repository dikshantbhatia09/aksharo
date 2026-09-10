import { describe, expect, it } from "vitest";

import {
  ALLOWED_MEDIA_EXTENSIONS,
  ALLOWED_MEDIA_MIME_TYPES,
  isAllowedMediaFile,
  MEDIA_ACCEPT_ATTRIBUTE,
  mediaExtensionOf,
  MIME_FALLBACK_EXTENSIONS,
} from "./media-formats.js";

describe("media format allow-list", () => {
  it("offers every accepted extension to the file picker", () => {
    // The bug this module exists to prevent: a picker that offers fewer
    // formats than the API accepts greys out a file the product supports.
    for (const extension of ALLOWED_MEDIA_EXTENSIONS) {
      expect(MEDIA_ACCEPT_ATTRIBUTE).toContain(`.${extension}`);
    }
  });

  it("offers every accepted MIME type to the file picker", () => {
    for (const mime of ALLOWED_MEDIA_MIME_TYPES) {
      expect(MEDIA_ACCEPT_ATTRIBUTE).toContain(mime);
    }
  });

  it("maps every MIME type to an extension that is itself allowed", () => {
    for (const mime of ALLOWED_MEDIA_MIME_TYPES) {
      const extension = MIME_FALLBACK_EXTENSIONS[mime];
      expect(extension, `${mime} has no fallback extension`).toBeDefined();
      expect(ALLOWED_MEDIA_EXTENSIONS).toContain(extension);
    }
  });

  it("names no fallback extension that is not allowed", () => {
    for (const [mime, extension] of Object.entries(MIME_FALLBACK_EXTENSIONS)) {
      expect(ALLOWED_MEDIA_MIME_TYPES, `${mime} maps but is not allowed`).toContain(mime);
      expect(ALLOWED_MEDIA_EXTENSIONS).toContain(extension);
    }
  });

  it("covers the formats the drop zone advertises", () => {
    // The copy under the drop zone promises these by name.
    for (const extension of ["mp4", "mov", "mkv", "webm", "mp3", "wav", "m4a", "aac"]) {
      expect(ALLOWED_MEDIA_EXTENSIONS).toContain(extension);
    }
  });

  it("keeps the formats a picker used to grey out", () => {
    // Regression: these were accepted by the API but missing from the web's
    // own hand-written list, so they could not be selected in the file dialog.
    for (const extension of ["m4v", "avi", "mpg", "mpeg", "3gp", "ogg", "oga", "opus", "flac"]) {
      expect(ALLOWED_MEDIA_EXTENSIONS).toContain(extension);
      expect(MEDIA_ACCEPT_ATTRIBUTE).toContain(`.${extension}`);
    }
  });
});

describe("mediaExtensionOf", () => {
  it.each([
    ["clip.mp4", "mp4"],
    ["IMG_8508.MOV", "mov"],
    ["holiday.final.mkv", "mkv"],
    ["no-extension", undefined],
    [".hidden", undefined],
    ["trailing.", undefined],
  ])("reads %s as %s", (filename, expected) => {
    expect(mediaExtensionOf(filename)).toBe(expected);
  });
});

describe("isAllowedMediaFile", () => {
  it("accepts an allowed MIME type", () => {
    expect(isAllowedMediaFile("clip.mp4", "video/mp4")).toBe(true);
    expect(isAllowedMediaFile("clip.MOV", "video/quicktime")).toBe(true);
  });

  it("accepts a known extension when the browser could not guess the type", () => {
    expect(isAllowedMediaFile("clip.mkv", "")).toBe(true);
    expect(isAllowedMediaFile("clip.m4v", "application/octet-stream")).toBe(true);
  });

  it("refuses a file that is not media at all", () => {
    expect(isAllowedMediaFile("notes.pdf", "application/pdf")).toBe(false);
    expect(isAllowedMediaFile("archive.zip", "")).toBe(false);
  });

  it("refuses exactly what the API refuses, and no more", () => {
    // A known extension carrying a wrong, non-generic type is a 415 at the API
    // (`assertAllowedType`); the client must not wave it through to be hashed
    // in full and then rejected.
    expect(isAllowedMediaFile("clip.mkv", "video/x-matroska-3d")).toBe(false);
  });
});
