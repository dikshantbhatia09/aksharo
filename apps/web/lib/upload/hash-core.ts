import { IncrementalSha256 } from "./sha256";

/** Read size for streaming a `Blob` into the hasher. Independent of the 16 MiB
 * multipart part size in `multipart.ts` — this one only bounds how much of the
 * file is ever in memory at once while hashing. */
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface HashProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

/**
 * The actual streaming hash, shared by the worker (`hash-worker.ts`) and the
 * no-Worker fallback (`hash-client.ts`) — one implementation either runs in,
 * so a bug fixed once is fixed in both places.
 */
export async function hashBlob(
  blob: Blob,
  onProgress?: (progress: HashProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hasher = new IncrementalSha256();
  const totalBytes = blob.size;
  let loadedBytes = 0;

  for (let offset = 0; offset < totalBytes; offset += HASH_CHUNK_BYTES) {
    if (signal?.aborted === true) {
      throw new DOMException("Hashing was cancelled.", "AbortError");
    }
    const slice = blob.slice(offset, Math.min(offset + HASH_CHUNK_BYTES, totalBytes));
    const buffer = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    loadedBytes += buffer.byteLength;
    onProgress?.({ loadedBytes, totalBytes });
  }

  return hasher.digestHex();
}
