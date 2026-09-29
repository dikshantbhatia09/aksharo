import { describe, expect, it } from "vitest";

import { probeImage } from "./image-probe.js";

/** Tiny real files, made with ffmpeg: a red square in each format the kit takes. */
const FIXTURES = {
  png8x4:
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP4z8DwHx9moL0CAHD0P8F+ACg+AAAAAElFTkSuQmCC",
  jpeg10x6:
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAYACgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=",
  webpLossy12x7:
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoMAAcAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
  webpLossless13x9: "UklGRhwAAABXRUJQVlA4TA8AAAAvDAACAAcQ9Y/+ByKi/wEA",
  webpAlpha15x11:
    "UklGRmAAAABXRUJQVlA4WAoAAAAQAAAADgAACgAAQUxQSAoAAAABB9C/iAhERP8DVlA4IDAAAADQAQCdASoPAAsAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
} as const;

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("probeImage", () => {
  it("reads a PNG's size from its header", () => {
    expect(probeImage(bytes(FIXTURES.png8x4))).toEqual({ format: "png", width: 8, height: 4 });
  });

  it("finds a JPEG's frame header past the segments before it", () => {
    expect(probeImage(bytes(FIXTURES.jpeg10x6))).toEqual({ format: "jpeg", width: 10, height: 6 });
  });

  it("reads the three kinds of WebP: lossy, lossless and extended", () => {
    expect(probeImage(bytes(FIXTURES.webpLossy12x7))).toEqual({
      format: "webp",
      width: 12,
      height: 7,
    });
    expect(probeImage(bytes(FIXTURES.webpLossless13x9))).toEqual({
      format: "webp",
      width: 13,
      height: 9,
    });
    expect(probeImage(bytes(FIXTURES.webpAlpha15x11))).toEqual({
      format: "webp",
      width: 15,
      height: 11,
    });
  });

  it("refuses what is not one of the three, however it is named", () => {
    expect(probeImage(new Uint8Array())).toBeUndefined();
    expect(probeImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe(
      undefined,
    );
    expect(probeImage(new TextEncoder().encode("GIF89a\x01\x00\x01\x00"))).toBeUndefined();
    // A PNG signature with nothing after it.
    expect(probeImage(bytes(FIXTURES.png8x4).slice(0, 12))).toBeUndefined();
    // A JPEG cut off before its frame header.
    expect(probeImage(bytes(FIXTURES.jpeg10x6).slice(0, 40))).toBeUndefined();
  });
});
