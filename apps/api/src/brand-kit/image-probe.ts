/**
 * What an uploaded logo really is (2026-10-02): its format from its first bytes
 * and its pixel size from its header, without decoding it.
 *
 * The declared content type is only a claim (the browser takes it from the
 * file name), and a presigned PUT only holds the upload to the type it was
 * signed for, not to what the bytes are. So a logo is accepted only when its
 * bytes open as the format it claims — a PNG, a JPEG or a WebP — and its size
 * is read here, from the header, for the renderers to size it by.
 */

export interface ImageFacts {
  readonly format: "png" | "jpeg" | "webp";
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, from: number, length: number): string {
  let text = "";
  for (let index = from; index < from + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes.at(index) ?? 0);
  }
  return text;
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes.at(at) ?? 0) << 8) | (bytes.at(at + 1) ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes.at(at) ?? 0) << 24) |
      ((bytes.at(at + 1) ?? 0) << 16) |
      ((bytes.at(at + 2) ?? 0) << 8) |
      (bytes.at(at + 3) ?? 0)) >>>
    0
  );
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes.at(at) ?? 0) | ((bytes.at(at + 1) ?? 0) << 8) | ((bytes.at(at + 2) ?? 0) << 16);
}

function png(bytes: Uint8Array): ImageFacts | undefined {
  if (bytes.length < 24) return undefined;
  if (!PNG_SIGNATURE.every((byte, index) => bytes.at(index) === byte)) return undefined;
  if (ascii(bytes, 12, 4) !== "IHDR") return undefined;
  return { format: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** Start-of-frame markers: every one but DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function jpeg(bytes: Uint8Array): ImageFacts | undefined {
  if (bytes.length < 4 || bytes.at(0) !== 0xff || bytes.at(1) !== 0xd8 || bytes.at(2) !== 0xff) {
    return undefined;
  }
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes.at(at) !== 0xff) return undefined;
    let marker = bytes.at(at + 1) ?? 0;
    // Fill bytes: any number of 0xFF before the marker itself.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes.at(at + 1) ?? 0;
    }
    // Markers with no length: TEM and RST0-7. SOI again or EOI end the search.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9) return undefined;
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return { format: "jpeg", height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

function webp(bytes: Uint8Array): ImageFacts | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return undefined;
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return { format: "webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (chunk === "VP8 ") {
    // A key frame's start code, then two 14-bit dimensions.
    if (bytes.at(23) !== 0x9d || bytes.at(24) !== 0x01 || bytes.at(25) !== 0x2a) return undefined;
    return {
      format: "webp",
      width: ((bytes.at(26) ?? 0) | ((bytes.at(27) ?? 0) << 8)) & 0x3fff,
      height: ((bytes.at(28) ?? 0) | ((bytes.at(29) ?? 0) << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes.at(20) !== 0x2f) return undefined;
    const bits =
      ((bytes.at(21) ?? 0) |
        ((bytes.at(22) ?? 0) << 8) |
        ((bytes.at(23) ?? 0) << 16) |
        ((bytes.at(24) ?? 0) << 24)) >>>
      0;
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** The image's format and size, or `undefined` when it is none of the three. */
export function probeImage(bytes: Uint8Array): ImageFacts | undefined {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}
