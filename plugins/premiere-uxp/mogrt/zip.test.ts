import { describe, expect, it } from "vitest";

import { readZip, writeZipStore, ZipParseError } from "./zip.js";

describe("zip", () => {
  it("round-trips a single entry", () => {
    const data = Buffer.from("hello aksharo", "utf8");
    const zip = writeZipStore([{ name: "hello.txt", data }]);
    const entries = readZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("hello.txt");
    expect(entries[0]!.data.toString("utf8")).toBe("hello aksharo");
  });

  it("round-trips multiple entries including empty ones, preserving order", () => {
    const zip = writeZipStore([
      { name: "definition.json", data: Buffer.from('{"a":1}', "utf8") },
      { name: "empty.txt", data: Buffer.alloc(0) },
      { name: "notes/readme.txt", data: Buffer.from("nested path", "utf8") },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "definition.json",
      "empty.txt",
      "notes/readme.txt",
    ]);
    expect(entries[1]!.data).toHaveLength(0);
    expect(entries[2]!.data.toString("utf8")).toBe("nested path");
  });

  it("round-trips binary data byte-exactly", () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const zip = writeZipStore([{ name: "bytes.bin", data }]);
    const [entry] = readZip(zip);
    expect(entry!.data.equals(data)).toBe(true);
  });

  it("throws ZipParseError on a non-zip buffer", () => {
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(ZipParseError);
  });

  it("produces a deterministic byte sequence for the same input", () => {
    const entries = [{ name: "a.txt", data: Buffer.from("x") }];
    expect(writeZipStore(entries).equals(writeZipStore(entries))).toBe(true);
  });
});
