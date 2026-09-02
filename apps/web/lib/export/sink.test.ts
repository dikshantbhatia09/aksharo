import { BufferTarget, StreamTarget } from "mediabunny";
import { describe, expect, it } from "vitest";

import { createExportTarget, createMemoryTarget, type SaveFilePickerLike } from "./sink";

describe("createMemoryTarget", () => {
  it("builds a BufferTarget-backed export target", () => {
    const target = createMemoryTarget();
    expect(target.kind).toBe("memory");
    expect(target.target).toBeInstanceOf(BufferTarget);
  });
});

describe("createExportTarget", () => {
  it("falls back to memory when showSaveFilePicker is unavailable", async () => {
    const target = await createExportTarget("out.mp4", { global: {} as never });
    expect(target.kind).toBe("memory");
  });

  it("falls back to memory when preferFileSystemAccess is false", async () => {
    const picker: SaveFilePickerLike = {
      showSaveFilePicker: async () => ({
        createWritable: async () => new WritableStream() as unknown as FileSystemWritableFileStream,
        getFile: async () => new File([], "out.mp4"),
      }),
    };
    const target = await createExportTarget("out.mp4", {
      preferFileSystemAccess: false,
      global: picker,
    });
    expect(target.kind).toBe("memory");
  });

  it("uses the File System Access target when the picker is available", async () => {
    let wrote = false;
    const picker: SaveFilePickerLike = {
      showSaveFilePicker: async () => ({
        // A real `FileSystemWritableFileStream` is a `WritableStream`
        // instance; mediabunny's `StreamTarget` checks that with `instanceof`,
        // so the fixture must be a real one too, not a duck-typed object.
        createWritable: async () =>
          new WritableStream({
            write: () => {
              wrote = true;
            },
          }) as unknown as FileSystemWritableFileStream,
        getFile: async () => new File([new Uint8Array([1, 2, 3])], "out.mp4"),
      }),
    };
    const target = await createExportTarget("out.mp4", { global: picker });
    expect(target.kind).toBe("file-system-access");
    expect(target.target).toBeInstanceOf(StreamTarget);
    expect(target.bufferAfterFinalize()).toBeNull();
    const finished = await target.readFinishedFile();
    expect(finished?.sizeBytes).toBe(3);
    expect(wrote).toBe(false);
  });
});
