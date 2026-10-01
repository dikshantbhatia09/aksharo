import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  ZipEntrySizeMismatchError,
  ZipEntryTooLargeError,
  zipLayout,
  zipStream,
  type ZipEntry,
} from "./zip-writer.js";

const AT = new Date(2026, 9, 1, 13, 45, 30);

function bytes(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/** An entry that yields `data` in chunks of `chunk` bytes. */
function entry(name: string, data: Buffer, chunk = 7): ZipEntry {
  return {
    name,
    size: data.length,
    modified: AT,
    open: async function* () {
      for (let at = 0; at < data.length; at += chunk) yield data.subarray(at, at + chunk);
    },
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

interface ReadEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly crc: number;
  readonly flags: number;
}

/**
 * A reader written from the spec, not from the writer: finds the end of
 * central directory (and the ZIP64 one through its locator), walks the
 * central directory, and reads each entry's data from its local header.
 */
function readZip(zip: Buffer): { readonly entries: ReadEntry[]; readonly zip64: boolean } {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBe(zip.length - 22);
  let count = zip.readUInt16LE(eocd + 10);
  let cdSize = zip.readUInt32LE(eocd + 12);
  let cdOffset = zip.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    zip64 = true;
    const locator = eocd - 20;
    expect(zip.readUInt32LE(locator)).toBe(0x07064b50);
    const record = Number(zip.readBigUInt64LE(locator + 8));
    expect(zip.readUInt32LE(record)).toBe(0x06064b50);
    count = Number(zip.readBigUInt64LE(record + 32));
    cdSize = Number(zip.readBigUInt64LE(record + 40));
    cdOffset = Number(zip.readBigUInt64LE(record + 48));
  }
  const entries: ReadEntry[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    let offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (offset === 0xffffffff) {
      const extra = at + 46 + nameLength;
      expect(zip.readUInt16LE(extra)).toBe(0x0001);
      offset = Number(zip.readBigUInt64LE(extra + 4));
    }
    expect(method).toBe(0);
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const localName = zip.readUInt16LE(offset + 26);
    const localExtra = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const data = zip.subarray(start, start + size);
    // The data descriptor right after the data repeats CRC and sizes.
    expect(zip.readUInt32LE(start + size)).toBe(0x08074b50);
    expect(zip.readUInt32LE(start + size + 4)).toBe(crc);
    expect(zip.readUInt32LE(start + size + 8)).toBe(size);
    entries.push({ name, data, crc, flags });
    at += 46 + nameLength + extraLength + commentLength;
  }
  expect(at).toBe(cdOffset + cdSize);
  return { entries, zip64 };
}

describe("zipStream", () => {
  it("writes a plain ZIP whose every entry reads back byte for byte", async () => {
    const files = [
      entry("Run/01 First clip/First clip 9x16.mp4", Buffer.alloc(1000, 7)),
      entry("Run/01 First clip/Words to post.txt", bytes("Hello\r\nworld")),
      entry("Run/Episode text.txt", bytes("")),
      entry("Run/02 हिंदी क्लिप/हिंदी 9x16.mp4", Buffer.from([1, 2, 3, 4, 5])),
    ];
    const zip = await collect(zipStream(files));

    expect(zip.length).toBe(zipLayout(files).totalBytes);
    const { entries, zip64 } = readZip(zip);
    expect(zip64).toBe(false);
    expect(entries.map((read) => read.name)).toEqual(files.map((file) => file.name));
    expect(entries[0]?.data.equals(Buffer.alloc(1000, 7))).toBe(true);
    expect(entries[1]?.data.toString("utf8")).toBe("Hello\r\nworld");
    expect(entries[2]?.data.length).toBe(0);
    for (const read of entries) {
      expect(read.crc).toBe(crc32(read.data) >>> 0);
      // UTF-8 names and a data descriptor.
      expect(read.flags & 0x0808).toBe(0x0808);
    }
  });

  it("moves to ZIP64 records once an offset passes the limit, and still reads back", async () => {
    const files = Array.from({ length: 6 }, (_, index) =>
      entry(`f${String(index)}.bin`, Buffer.alloc(100 + index, index)),
    );
    const zip = await collect(zipStream(files, { zip64At: 300 }));

    const layout = zipLayout(files, { zip64At: 300 });
    expect(layout.zip64).toBe(true);
    expect(zip.length).toBe(layout.totalBytes);
    const { entries, zip64 } = readZip(zip);
    expect(zip64).toBe(true);
    entries.forEach((read, index) => {
      expect(read.data.equals(Buffer.alloc(100 + index, index))).toBe(true);
    });
  });

  it("opens each entry only when its turn comes", async () => {
    const opened: string[] = [];
    const lazy = (name: string): ZipEntry => ({
      name,
      size: 3,
      modified: AT,
      open: () => {
        opened.push(name);
        return (async function* () {
          yield bytes("abc");
        })();
      },
    });
    const stream = zipStream([lazy("a"), lazy("b")]);
    await stream.next(); // a's header
    expect(opened).toEqual([]);
    await stream.next(); // a's data
    expect(opened).toEqual(["a"]);
    await collect(stream);
    expect(opened).toEqual(["a", "b"]);
  });

  it("stops the archive when a file is longer or shorter than it said", async () => {
    const short: ZipEntry = { ...entry("short", bytes("abc")), size: 4 };
    await expect(collect(zipStream([short]))).rejects.toBeInstanceOf(ZipEntrySizeMismatchError);
    const long: ZipEntry = { ...entry("long", bytes("abcdef")), size: 2 };
    await expect(collect(zipStream([long]))).rejects.toBeInstanceOf(ZipEntrySizeMismatchError);
  });

  it("refuses a single file of 4 GiB or more", () => {
    expect(() =>
      zipLayout([{ name: "huge.mp4", size: 0xffffffff, modified: AT }]),
    ).toThrow(ZipEntryTooLargeError);
  });
});
