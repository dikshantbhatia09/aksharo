import { crc32 } from "node:zlib";

/**
 * A ZIP archive written as a stream (2026-10-01, "Download all"): every file
 * STORED (videos and JPEGs do not compress), each entry's CRC-32 computed as
 * its bytes go by and written after them in a data descriptor, so nothing is
 * read twice and nothing is held in memory or on disk.
 *
 * **The archive's length is known before the first byte** ({@link zipLayout}):
 * every entry's size is known in advance (the store's `HEAD`), and with the
 * CRC in the data descriptor no header depends on the data. The response can
 * then carry `Content-Length`, which is what lets a browser show a download's
 * progress and time left.
 *
 * **ZIP64 only where it is needed** - an entry at or past 4 GiB into the
 * archive, a central directory past it, or more than 65 535 entries - so a
 * small archive is a plain ZIP every unzipper reads. A single file of 4 GiB or
 * more is refused (no clip, shape or compilation comes near it), which keeps
 * every local header and data descriptor in the 32-bit form.
 *
 * Names are UTF-8 (general purpose flag bit 11).
 */

/** One file in the archive. `size` must be exactly what `open` yields. */
export interface ZipEntry {
  readonly name: string;
  readonly size: number;
  readonly modified: Date;
  readonly open: () => Promise<AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>;
}

export interface ZipOptions {
  /**
   * Where ZIP64 takes over; 0xFFFFFFFF in every real archive. A test lowers it
   * to exercise the ZIP64 records on a small one.
   */
  readonly zip64At?: number;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** UTF-8 names (bit 11) + sizes and CRC in a data descriptor (bit 3). */
const FLAGS = 0x0808;
const STORE = 0;
const VERSION_PLAIN = 20;
const VERSION_ZIP64 = 45;

const LOCAL_HEADER = 30;
const DATA_DESCRIPTOR = 16;
const CENTRAL_HEADER = 46;
const ZIP64_OFFSET_EXTRA = 12;
const ZIP64_EOCD = 56;
const ZIP64_LOCATOR = 20;
const EOCD = 22;

export class ZipEntryTooLargeError extends Error {
  constructor(readonly entryName: string) {
    super(`a file of 4 GiB or more cannot be stored: ${entryName}`);
    this.name = "ZipEntryTooLargeError";
  }
}

export class ZipEntrySizeMismatchError extends Error {
  constructor(
    readonly entryName: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${entryName}: expected ${String(expected)} bytes, read ${String(actual)}`);
    this.name = "ZipEntrySizeMismatchError";
  }
}

interface PlannedEntry {
  readonly name: Buffer;
  readonly size: number;
  readonly offset: number;
  readonly zip64Offset: boolean;
  readonly modified: Date;
}

interface Plan {
  readonly entries: readonly PlannedEntry[];
  readonly centralOffset: number;
  readonly centralSize: number;
  readonly zip64: boolean;
  readonly totalBytes: number;
}

function plan(
  entries: readonly Pick<ZipEntry, "name" | "size" | "modified">[],
  options: ZipOptions,
): Plan {
  const limit = options.zip64At ?? MAX32;
  let offset = 0;
  const planned: PlannedEntry[] = [];
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new RangeError(`${entry.name}: not a size: ${String(entry.size)}`);
    }
    if (entry.size >= MAX32) throw new ZipEntryTooLargeError(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    if (name.length === 0 || name.length > MAX16) {
      throw new RangeError(`a name must be 1-65535 bytes: ${entry.name}`);
    }
    planned.push({
      name,
      size: entry.size,
      offset,
      zip64Offset: offset >= limit,
      modified: entry.modified,
    });
    offset += LOCAL_HEADER + name.length + entry.size + DATA_DESCRIPTOR;
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of planned) {
    centralSize += CENTRAL_HEADER + entry.name.length + (entry.zip64Offset ? ZIP64_OFFSET_EXTRA : 0);
  }
  const zip64 =
    planned.length > MAX16 - 1 ||
    centralOffset >= limit ||
    centralSize >= limit ||
    planned.some((entry) => entry.zip64Offset);
  const totalBytes =
    centralOffset + centralSize + (zip64 ? ZIP64_EOCD + ZIP64_LOCATOR : 0) + EOCD;
  return { entries: planned, centralOffset, centralSize, zip64, totalBytes };
}

/** The archive's exact length, and whether it needs ZIP64, without reading anything. */
export function zipLayout(
  entries: readonly Pick<ZipEntry, "name" | "size" | "modified">[],
  options: ZipOptions = {},
): { readonly totalBytes: number; readonly zip64: boolean } {
  const { totalBytes, zip64 } = plan(entries, options);
  return { totalBytes, zip64 };
}

/** MS-DOS date and time, in the server's local time (ZIP has no time zone). */
function dosDateTime(at: Date): { readonly date: number; readonly time: number } {
  const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
  };
}

function localHeader(entry: PlannedEntry): Buffer {
  const out = Buffer.alloc(LOCAL_HEADER + entry.name.length);
  const { date, time } = dosDateTime(entry.modified);
  out.writeUInt32LE(0x04034b50, 0);
  out.writeUInt16LE(VERSION_PLAIN, 4);
  out.writeUInt16LE(FLAGS, 6);
  out.writeUInt16LE(STORE, 8);
  out.writeUInt16LE(time, 10);
  out.writeUInt16LE(date, 12);
  // CRC and sizes are zero here and follow the data (bit 3).
  out.writeUInt32LE(0, 14);
  out.writeUInt32LE(0, 18);
  out.writeUInt32LE(0, 22);
  out.writeUInt16LE(entry.name.length, 26);
  out.writeUInt16LE(0, 28);
  entry.name.copy(out, LOCAL_HEADER);
  return out;
}

function dataDescriptor(crc: number, size: number): Buffer {
  const out = Buffer.alloc(DATA_DESCRIPTOR);
  out.writeUInt32LE(0x08074b50, 0);
  out.writeUInt32LE(crc >>> 0, 4);
  out.writeUInt32LE(size, 8);
  out.writeUInt32LE(size, 12);
  return out;
}

function centralHeader(entry: PlannedEntry, crc: number): Buffer {
  const extra = entry.zip64Offset ? ZIP64_OFFSET_EXTRA : 0;
  const out = Buffer.alloc(CENTRAL_HEADER + entry.name.length + extra);
  const { date, time } = dosDateTime(entry.modified);
  const version = entry.zip64Offset ? VERSION_ZIP64 : VERSION_PLAIN;
  out.writeUInt32LE(0x02014b50, 0);
  out.writeUInt16LE(version, 4); // made by: MS-DOS, this spec version
  out.writeUInt16LE(version, 6); // needed to extract
  out.writeUInt16LE(FLAGS, 8);
  out.writeUInt16LE(STORE, 10);
  out.writeUInt16LE(time, 12);
  out.writeUInt16LE(date, 14);
  out.writeUInt32LE(crc >>> 0, 16);
  out.writeUInt32LE(entry.size, 20);
  out.writeUInt32LE(entry.size, 24);
  out.writeUInt16LE(entry.name.length, 28);
  out.writeUInt16LE(extra, 30);
  out.writeUInt16LE(0, 32); // comment
  out.writeUInt16LE(0, 34); // disk
  out.writeUInt16LE(0, 36); // internal attributes
  out.writeUInt32LE(0, 38); // external attributes
  out.writeUInt32LE(entry.zip64Offset ? MAX32 : entry.offset, 42);
  entry.name.copy(out, CENTRAL_HEADER);
  if (entry.zip64Offset) {
    const at = CENTRAL_HEADER + entry.name.length;
    out.writeUInt16LE(0x0001, at);
    out.writeUInt16LE(8, at + 2);
    out.writeBigUInt64LE(BigInt(entry.offset), at + 4);
  }
  return out;
}

function endRecords(layout: Plan): Buffer {
  const count = layout.entries.length;
  const parts: Buffer[] = [];
  if (layout.zip64) {
    const record = Buffer.alloc(ZIP64_EOCD);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(ZIP64_EOCD - 12), 4);
    record.writeUInt16LE(VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(layout.centralSize), 40);
    record.writeBigUInt64LE(BigInt(layout.centralOffset), 48);
    const locator = Buffer.alloc(ZIP64_LOCATOR);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(layout.centralOffset + layout.centralSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(EOCD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(layout.zip64 ? MAX16 : count, 8);
  end.writeUInt16LE(layout.zip64 ? MAX16 : count, 10);
  end.writeUInt32LE(layout.zip64 ? MAX32 : layout.centralSize, 12);
  end.writeUInt32LE(layout.zip64 ? MAX32 : layout.centralOffset, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * The archive, chunk by chunk, exactly {@link zipLayout}'s `totalBytes` long.
 * Each entry is opened only when its turn comes. Throws (and so ends the
 * response) when an entry yields more or fewer bytes than its declared size.
 */
export async function* zipStream(
  entries: readonly ZipEntry[],
  options: ZipOptions = {},
): AsyncGenerator<Uint8Array, void, undefined> {
  const layout = plan(entries, options);
  const crcs: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const planned = layout.entries.at(index);
    if (planned === undefined) continue;
    yield localHeader(planned);
    let crc = 0;
    let read = 0;
    for await (const chunk of await entry.open()) {
      if (chunk.byteLength === 0) continue;
      read += chunk.byteLength;
      if (read > planned.size) throw new ZipEntrySizeMismatchError(entry.name, planned.size, read);
      crc = crc32(chunk, crc);
      yield chunk;
    }
    if (read !== planned.size) throw new ZipEntrySizeMismatchError(entry.name, planned.size, read);
    crcs.push(crc);
    yield dataDescriptor(crc, planned.size);
  }
  for (const [index, planned] of layout.entries.entries()) {
    yield centralHeader(planned, crcs.at(index) ?? 0);
  }
  yield endRecords(layout);
}
