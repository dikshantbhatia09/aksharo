import { describe, expect, it } from "vitest";

import { hashFile } from "./hash-client";
import { sha256Hex } from "./sha256";

describe("hashFile (no-Worker fallback: this suite runs without a real Worker global)", () => {
  it("hashes a Blob and reports progress up to the full size", async () => {
    // Two chunks' worth (`HASH_CHUNK_BYTES` is 4 MiB) is enough to prove
    // streaming and progress both work; a pure-JS SHA-256 over anything
    // much larger is slow under v8 coverage instrumentation specifically.
    const bytes = new Uint8Array(5_000_000).map((_, i) => i % 256);
    const blob = new Blob([bytes]);

    const progressCalls: { loadedBytes: number; totalBytes: number }[] = [];
    const hex = await hashFile(blob, (progress) => {
      progressCalls.push(progress);
    });

    expect(hex).toBe(sha256Hex(bytes));
    expect(progressCalls.length).toBeGreaterThan(1);
    expect(progressCalls.at(-1)).toEqual({ loadedBytes: blob.size, totalBytes: blob.size });
  }, 30_000);

  it("respects an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const blob = new Blob([new Uint8Array(1024)]);
    await expect(hashFile(blob, undefined, controller.signal)).rejects.toThrow();
  });
});
