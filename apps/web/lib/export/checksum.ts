/**
 * SHA-256 of the finished export, for `POST /exports/manifests/{id}/complete`.
 *
 * The output caps (1080p ≤ 20 min, 4K ≤ 10 min) bound the file to a size
 * `SubtleCrypto.digest` can hash in one call without the incremental-hashing
 * concern `apps/web/lib/upload/sha256.ts` exists for (that one hashes
 * multi-gigabyte raw uploads a slice at a time); a finished MP4 here is at
 * most a few hundred MB, well inside what `digest()` handles directly.
 */

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
