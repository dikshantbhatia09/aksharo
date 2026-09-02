/**
 * The derived object keys of `docs/CONTRACTS.md` §6, and nothing else.
 *
 * ```
 * raw     (S3) ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}
 * derived (R2) ws/{workspaceId}/p/{projectId}/media/{mediaId}/{audio16k.wav|audio48k.wav
 *                                                              |proxy540.mp4|waveform.json
 *                                                              |thumb-{n}.jpg}
 * ```
 *
 * The third copy of a thing that has to agree three ways: this file, the API's
 * `apps/api/src/common/storage/storage.keys.ts` and the Python
 * `apps/worker-ai/worker_ai/storage.py`. They are only ever correct together, so
 * `storage-keys.test.ts` parses the API's source and pins the artefact list.
 *
 * Every id validates as a ULID before it reaches a key. That is not pedantry: an
 * id arrives inside a job payload, a key is a path, and `../` in an id would be a
 * cross-tenant write (THREAT-MODEL T5). The API refuses a patch whose keys fall
 * outside the asset's own prefix, so a worker that skipped this would simply have
 * its work rejected — which is the belt to this braces.
 */

/** Crockford base32, 26 characters — CONTRACTS §0 ids. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Raised when an id would produce a key we do not trust. */
export class StorageKeyError extends Error {
  public override readonly name = "StorageKeyError";
}

/** The derived artefacts CONTRACTS §6 names, minus the numbered thumbnails. */
export const DERIVED_ARTEFACTS = [
  "audio16k.wav",
  "audio48k.wav",
  "proxy540.mp4",
  "waveform.json",
] as const;

export type DerivedArtefact = (typeof DERIVED_ARTEFACTS)[number];

function checkedId(kind: string, value: string): string {
  if (!ULID_PATTERN.test(value)) {
    throw new StorageKeyError(`${kind} is not a ULID: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `ws/{workspaceId}/p/{projectId}/media/{mediaId}` — the prefix both stores share. */
export function mediaPrefix(workspaceId: string, projectId: string, mediaId: string): string {
  return (
    `ws/${checkedId("workspaceId", workspaceId)}` +
    `/p/${checkedId("projectId", projectId)}` +
    `/media/${checkedId("mediaId", mediaId)}`
  );
}

/** Derived-media key, in the R2 bucket. */
export function derivedKey(prefix: string, artefact: DerivedArtefact): string {
  if (!DERIVED_ARTEFACTS.includes(artefact)) {
    throw new StorageKeyError(`${JSON.stringify(artefact)} is not a CONTRACTS §6 artefact`);
  }
  return `${prefix}/${artefact}`;
}

/** `thumb-{n}.jpg`, in the R2 bucket. */
export function thumbKey(prefix: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new StorageKeyError("thumbnail index must be a non-negative integer");
  }
  return `${prefix}/thumb-${String(index)}.jpg`;
}

/** Every derived key one media asset can have, given how many thumbnails exist. */
export function allDerivedKeys(prefix: string, thumbCount: number): string[] {
  return [
    ...DERIVED_ARTEFACTS.map((artefact) => derivedKey(prefix, artefact)),
    ...Array.from({ length: Math.max(0, thumbCount) }, (_unused, index) =>
      thumbKey(prefix, index),
    ),
  ];
}
