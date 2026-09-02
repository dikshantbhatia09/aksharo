/**
 * A tiny, dependency-free ZIP reader/writer.
 *
 * The `.mogrt` container is a zip file. No zip library is a dependency of this
 * workspace yet (checked before writing this), and pulling one in for ~100
 * lines of well-understood format is not worth the new supply-chain surface.
 * This writer only ever uses the STORE method (no compression) — valid per the
 * zip spec (compression method 0) and trivial to get byte-exact, which matters
 * more here than file size: the placeholder is a few KB of JSON and text.
 *
 * Deliberately minimal: no directories, no zip64, no extra fields beyond what
 * every reader (Windows Explorer, macOS Archive Utility, Adobe's own MOGRT
 * importer, Node's own future consumers) needs to accept a well-formed zip.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

/** CRC-32 (IEEE 802.3), computed with our own table — no dependency on Node version-specific zlib.crc32. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const tableEntry = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = tableEntry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time fixed at the zip epoch start — deterministic output, no wall-clock dependency. */
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

export function writeZipStore(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18); // compressed size
    localHeader.writeUInt32LE(size, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: store
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralDirOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

export class ZipParseError extends Error {
  override readonly name = "ZipParseError";
}

/** Reads a zip written by `writeZipStore` or any other STORE/DEFLATE-free zip. */
export function readZip(buffer: Buffer): ZipEntry[] {
  const eocdSig = Buffer.alloc(4);
  eocdSig.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  const eocdIndex = buffer.lastIndexOf(eocdSig);
  if (eocdIndex === -1) {
    throw new ZipParseError("not a zip file: end-of-central-directory record not found");
  }

  const totalEntries = buffer.readUInt16LE(eocdIndex + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdIndex + 16);

  const entries: ZipEntry[] = [];
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    const sig = buffer.readUInt32LE(cursor);
    if (sig !== CENTRAL_DIR_HEADER_SIG) {
      throw new ZipParseError(`central directory entry ${i} has a bad signature`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (method !== 0) {
      throw new ZipParseError(
        `entry "${name}" uses compression method ${method}; only STORE (0) is supported`,
      );
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.push({ name, data: Buffer.from(data) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
