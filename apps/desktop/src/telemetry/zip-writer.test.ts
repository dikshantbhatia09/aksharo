import { describe, expect, it } from "vitest";

import { buildZip } from "./zip-writer.js";

/** Minimal store-only zip reader, for round-tripping in this test only. */
function readStoredZip(buffer: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    const signature = buffer.readUInt32LE(pos);
    if (signature !== 0x04034b50) break;
    const nameLength = buffer.readUInt16LE(pos + 26);
    const extraLength = buffer.readUInt16LE(pos + 28);
    const size = buffer.readUInt32LE(pos + 18);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    const data = buffer.subarray(dataStart, dataStart + size);
    entries.push({ name, data });
    pos = dataStart + size;
  }
  return entries;
}

describe("buildZip", () => {
  it("round-trips a single text entry", () => {
    const zip = buildZip([{ name: "logs.txt", data: Buffer.from("hello world", "utf8") }]);
    const entries = readStoredZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("logs.txt");
    expect(entries[0]?.data.toString("utf8")).toBe("hello world");
  });

  it("round-trips multiple entries in order", () => {
    const zip = buildZip([
      { name: "config.json", data: Buffer.from('{"a":1}', "utf8") },
      { name: "logs.txt", data: Buffer.from("line1\nline2", "utf8") },
      { name: "versions.json", data: Buffer.from('{"app":"1.0.0"}', "utf8") },
    ]);
    const entries = readStoredZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["config.json", "logs.txt", "versions.json"]);
    expect(entries[1]?.data.toString("utf8")).toBe("line1\nline2");
  });

  it("handles an empty file list", () => {
    const zip = buildZip([]);
    expect(readStoredZip(zip)).toEqual([]);
    // Still a valid (empty) archive: ends with the end-of-central-directory signature.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it("handles an empty entry", () => {
    const zip = buildZip([{ name: "empty.txt", data: Buffer.alloc(0) }]);
    const entries = readStoredZip(zip);
    expect(entries[0]?.data.length).toBe(0);
  });
});
