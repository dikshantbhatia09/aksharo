/**
 * Output target: stream to disk via the File System Access API when
 * available, else buffer in memory (brief §3). A `FileSystemWritableFileStream`
 * (from `handle.createWritable()`) is itself a `WritableStream`, so it is
 * handed straight to Mediabunny's `StreamTarget` — no adapter needed. The
 * in-memory path uses `BufferTarget` and the finished bytes come back from
 * `output.target.buffer` after `finalize()`.
 *
 * FSA streaming keeps the whole export off the JS heap, which is the point of
 * the hard duration caps (`BROWSER_DURATION_CAPS_MS`): a `BufferTarget` still
 * has to hold the finished file in memory at once, so a browser without FSA
 * (Safari, Firefox) is capped tighter by the decision engine even before this
 * module runs.
 */

import { BufferTarget, StreamTarget, type Target } from "mediabunny";

export interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableFileStream>;
  getFile(): Promise<File>;
}

export interface SaveFilePickerLike {
  showSaveFilePicker(options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandleLike>;
}

export interface ExportTarget {
  readonly kind: "file-system-access" | "memory";
  readonly target: Target;
  /** `null` for the FSA target — the file is already on disk once `finalize()` resolves. */
  bufferAfterFinalize(): ArrayBuffer | null;
  /**
   * For the FSA target: re-reads the just-written file to report its size and
   * bytes for the checksum `POST /exports/manifests/{id}/complete` needs. This
   * re-read is a deliberate, one-time cost at the end, not during encoding —
   * the whole point of streaming to disk is that the encode loop itself never
   * holds the file in memory.
   */
  readFinishedFile(): Promise<{ sizeBytes: number; bytes: ArrayBuffer } | null>;
}

class MemoryExportTarget implements ExportTarget {
  readonly kind = "memory" as const;
  readonly target: BufferTarget;

  constructor() {
    this.target = new BufferTarget();
  }

  bufferAfterFinalize(): ArrayBuffer | null {
    return this.target.buffer;
  }

  async readFinishedFile(): Promise<null> {
    return null;
  }
}

class FileSystemExportTarget implements ExportTarget {
  readonly kind = "file-system-access" as const;
  readonly target: StreamTarget;

  constructor(
    private readonly handle: FileSystemFileHandleLike,
    writable: FileSystemWritableFileStream,
  ) {
    this.target = new StreamTarget(writable as unknown as WritableStream);
  }

  bufferAfterFinalize(): null {
    return null;
  }

  async readFinishedFile(): Promise<{ sizeBytes: number; bytes: ArrayBuffer }> {
    const file = await this.handle.getFile();
    const bytes = await file.arrayBuffer();
    return { sizeBytes: file.size, bytes };
  }
}

export async function createExportTarget(
  suggestedName: string,
  options: { preferFileSystemAccess?: boolean; global?: SaveFilePickerLike } = {},
): Promise<ExportTarget> {
  const g = options.global ?? (globalThis as unknown as SaveFilePickerLike);
  const wantsFsa = options.preferFileSystemAccess ?? true;
  if (wantsFsa && typeof g.showSaveFilePicker === "function") {
    const handle = await g.showSaveFilePicker({
      suggestedName,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
    const writable = await handle.createWritable();
    return new FileSystemExportTarget(handle, writable);
  }
  return new MemoryExportTarget();
}

export function createMemoryTarget(): ExportTarget {
  return new MemoryExportTarget();
}
