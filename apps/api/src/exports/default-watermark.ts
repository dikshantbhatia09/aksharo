/**
 * The bundled Free-tier watermark, synthesised as a small PNG rather than
 * shipped as a binary asset.
 *
 * `apps/render`'s `brandAssetKey` (`apps/render/src/storage.ts`, A20) resolves
 * *every* `watermark.assetId` — including the platform's own default —
 * per-workspace: `ws/{workspaceId}/brand/{assetId}.png`. There is no bundled,
 * workspace-independent fallback anywhere in the render path (proved by running
 * the real worker in `test/exports-render.e2e-spec.ts`, which failed with
 * `storage/unreadable` before this existed). So the API provisions the object
 * itself, once per workspace, the first time that workspace needs a watermarked
 * export — {@link ensureDefaultWatermark}.
 *
 * The pixels are a placeholder: a semi-transparent solid badge, not the real
 * Aksharo wordmark, because rendering brand artwork is a design asset this work
 * package does not own. Swapping it for the real mark later is a `put()` of new
 * bytes at the same key — every workspace's manifest already points at it by
 * name, so nothing about the render path or the signed document changes.
 */

import { deflateSync } from "node:zlib";

const WIDTH = 240;
const HEIGHT = 67; // matches apps/render's WATERMARK_ASPECT (0.28) closely enough to look right
/** Aksharo navy, ~85% opaque — the same opacity the manifest asks for. */
const RGBA: readonly [number, number, number, number] = [0x14, 0x1b, 0x3c, 0xd9];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let cachedCrcTable: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (cachedCrcTable !== undefined) return cachedCrcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  cachedCrcTable = table;
  return table;
}

function crc32(buf: Buffer): number {
  const table = crcTable();
  let c = 0xffffffff;
  for (const byte of buf) c = (table[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Builds the placeholder watermark PNG in memory. Deterministic; cheap enough not to cache. */
export function buildDefaultWatermarkPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const [r, g, b, a] = RGBA;
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowStart = y * (1 + WIDTH * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < WIDTH; x += 1) {
      const pixel = rowStart + 1 + x * 4;
      raw[pixel] = r;
      raw[pixel + 1] = g;
      raw[pixel + 2] = b;
      raw[pixel + 3] = a;
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
