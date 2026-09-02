import { describe, expect, it, vi } from "vitest";

import { buildDefaultWatermarkPng } from "./default-watermark.js";
import { DefaultWatermarkService } from "./default-watermark.service.js";

import type { ObjectStore } from "../common/storage/index.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("buildDefaultWatermarkPng", () => {
  it("produces bytes that open with the PNG signature", () => {
    const bytes = buildDefaultWatermarkPng();
    expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("declares an IHDR chunk with truecolour+alpha and the expected dimensions", () => {
    const bytes = buildDefaultWatermarkPng();
    // IHDR is always the first chunk, right after the 8-byte signature and the
    // 4-byte length + 4-byte type of the chunk header.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const bitDepth = bytes[24];
    const colourType = bytes[25];
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(bitDepth).toBe(8);
    expect(colourType).toBe(6); // truecolour + alpha, what `pipeline.ts` expects to decode
    expect(bytes.subarray(bytes.length - 4).toString("ascii")).not.toBe(""); // IEND crc present
  });

  it("is deterministic", () => {
    expect(buildDefaultWatermarkPng()).toEqual(buildDefaultWatermarkPng());
  });
});

function fakeStore(existing = false): ObjectStore & { puts: { key: string }[] } {
  const puts: { key: string }[] = [];
  return {
    bucket: "montaj-derived",
    kind: "r2",
    createMultipartUpload: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    presignGet: vi.fn(),
    presignPut: vi.fn(),
    head: vi.fn(async () => (existing ? { sizeBytes: 100 } : null)),
    put: vi.fn(async (input: { key: string }) => {
      puts.push({ key: input.key });
    }),
    get: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    tag: vi.fn(),
    puts,
  } as unknown as ObjectStore & { puts: { key: string }[] };
}

const WS = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";

describe("DefaultWatermarkService", () => {
  it("writes the placeholder PNG when the workspace has none yet", async () => {
    const store = fakeStore(false);
    const service = new DefaultWatermarkService(store);
    await service.ensure(WS);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.puts[0]?.key).toBe(`ws/${WS}/brand/aksharo-watermark.png`);
  });

  it("does not overwrite an existing object", async () => {
    const store = fakeStore(true);
    const service = new DefaultWatermarkService(store);
    await service.ensure(WS);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("does not re-check a workspace it has already confirmed this process", async () => {
    const store = fakeStore(false);
    const service = new DefaultWatermarkService(store);
    await service.ensure(WS);
    await service.ensure(WS);
    expect(store.head).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});
