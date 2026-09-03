/**
 * Test helpers: real fonts out of the bundled pack, and the crafted bad ones
 * the validator has to refuse.
 *
 * Exported as `@montaj/fonts/testing` so `apps/api`'s upload e2e uploads the
 * same bytes this package's unit tests validate — a suite that invented its own
 * "font" would be testing its own fixture rather than the pipeline.
 *
 * Node only: it reads the pack off disk.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bundledPackDirectory, readPackManifest } from "./pack.js";

import type { FontManifest } from "./manifest.js";

/** Bytes of one face in the bundled pack, by id (`noto-sans-devanagari-400`). */
export function packFontBytes(id: string, extension: "ttf" | "woff2" = "ttf"): Uint8Array {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  return new Uint8Array(readFileSync(join(bundledPackDirectory(), `${id}.${extension}`)));
}

/** A real, valid, small font: the Latin Noto Sans face of the bundled pack. */
export function sampleLatinFont(): Uint8Array {
  return packFontBytes("noto-sans-400");
}

/** A real Devanagari face, for coverage and subsetting tests. */
export function sampleDevanagariFont(): Uint8Array {
  return packFontBytes("noto-sans-devanagari-400");
}

/** A real Tamil face. */
export function sampleTamilFont(): Uint8Array {
  return packFontBytes("noto-sans-tamil-400");
}

export async function loadTestManifest(): Promise<FontManifest> {
  return readPackManifest();
}

/**
 * Something that is not a font at all but claims to be one.
 *
 * The first four bytes are a valid `0x00010000` sfnt version and the table
 * directory is nonsense, which is exactly the shape of a hostile upload: a file
 * that gets past a sniffing check and falls over inside the parser (T7).
 */
export function fakeTtfBytes(sizeBytes = 4_096): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set([0x00, 0x01, 0x00, 0x00], 0);
  // numTables = 400, which no real font has and which points every table record
  // past the end of the file.
  bytes[4] = 0x01;
  bytes[5] = 0x90;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  for (let index = 12; index < sizeBytes; index += 1) bytes[index] = (index * 31) % 251;
  return bytes;
}

/** Bytes that are not a font by any signature. */
export function notAFontBytes(): Uint8Array {
  return new TextEncoder().encode("PK this is a zip, not a font");
}

/** The four bytes that make a file a TrueType collection. */
export function collectionBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode("ttcf"), 0);
  return bytes;
}

/** Read a big-endian 16-bit value. */
function readU16(bytes: Uint8Array, offset: number): number {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

/** The offset of a table in an sfnt, or `undefined`. */
export function tableOffset(bytes: Uint8Array, tag: string): number | undefined {
  const numTables = readU16(bytes, 4);
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > bytes.byteLength) return undefined;
    const found = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (found !== tag) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(record + 8);
  }
  return undefined;
}

/**
 * The same font with a different `OS/2.fsType`.
 *
 * `fsType` sits at offset 8 of the OS/2 table (version, xAvgCharWidth,
 * usWeightClass, usWidthClass, then fsType), and the table has no checksum a
 * parser enforces, so patching those two bytes produces a font that is valid in
 * every way except that it now says what it says. Values: `0x0002` no
 * embedding, `0x0004` preview and print only, `0x0200` bitmap embedding only,
 * `0x0100` no subsetting.
 */
export function withFsType(bytes: Uint8Array, fsType: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const offset = tableOffset(copy, "OS/2");
  if (offset === undefined) throw new Error("the font has no OS/2 table to patch");
  copy[offset + 8] = (fsType >> 8) & 0xff;
  copy[offset + 9] = fsType & 0xff;
  return copy;
}

/** No-embedding (`fsType` bit 1). */
export function withNoEmbedding(bytes: Uint8Array): Uint8Array {
  return withFsType(bytes, 0x0002);
}

/** Preview-and-print only (`fsType` bit 2). */
export function withViewOnlyEmbedding(bytes: Uint8Array): Uint8Array {
  return withFsType(bytes, 0x0004);
}

/** Bitmap embedding only (`fsType` bit 9). */
export function withBitmapOnlyEmbedding(bytes: Uint8Array): Uint8Array {
  return withFsType(bytes, 0x0200);
}

/** A font that may be embedded but not subset (`fsType` bit 8). */
export function withNoSubsetting(bytes: Uint8Array): Uint8Array {
  return withFsType(bytes, 0x0100);
}

/** The same font with `head.unitsPerEm` set to a value no renderer accepts. */
export function withUnitsPerEm(bytes: Uint8Array, unitsPerEm: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const offset = tableOffset(copy, "head");
  if (offset === undefined) throw new Error("the font has no head table to patch");
  copy[offset + 18] = (unitsPerEm >> 8) & 0xff;
  copy[offset + 19] = unitsPerEm & 0xff;
  return copy;
}

/** Bytes larger than a cap, cheaply, without allocating a real font. */
export function oversizeBytes(sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set([0x00, 0x01, 0x00, 0x00], 0);
  return bytes;
}
