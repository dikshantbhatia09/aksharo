/**
 * The object keys of `docs/CONTRACTS.md` §6, and nothing else.
 *
 * ```
 * raw     (S3) ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}
 * derived (R2) ws/{workspaceId}/p/{projectId}/media/{mediaId}/{audio16k.wav|audio48k.wav
 *                                                              |proxy540.mp4|waveform.json
 *                                                              |thumb-{n}.jpg}
 * exports (R2) ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}
 * fonts   (R2) ws/{workspaceId}/fonts/{fontId}.{ttf|otf|woff2}
 * ```
 *
 * This is the TypeScript twin of `apps/worker-ai/worker_ai/storage.py`, which the
 * Python pipeline reads the same objects with. The two are only ever correct
 * together, so both validate their inputs the same way: an id that is not a ULID
 * never reaches a key. That is not pedantry — every id in a key arrives from a
 * request or a job payload, and a key is a path, so `../` in an id would be a
 * cross-tenant write (THREAT-MODEL T5).
 */

/** Crockford base32, 26 characters — CONTRACTS §0 ids. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A file extension we are willing to paste into a key. */
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;

/**
 * A ULID, or the platform's own well-known asset slugs (`aksharo-watermark`,
 * `manifest-builder.ts`'s `DEFAULT_WATERMARK_ASSET_ID`) — never anything else,
 * so a key is still never built from an attacker-controlled string.
 */
const BRAND_ASSET_ID_PATTERN = /^([0-9A-HJKMNP-TV-Z]{26}|[a-z][a-z0-9-]{0,62}[a-z0-9])$/;

/** Raised when an id or an extension would produce a key we do not trust. */
export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageKeyError";
  }
}

/** The derived artefacts CONTRACTS §6 names, minus the numbered thumbnails. */
export const DERIVED_ARTEFACTS = [
  "audio16k.wav",
  "audio48k.wav",
  "proxy540.mp4",
  "waveform.json",
] as const;

export type DerivedArtefact = (typeof DERIVED_ARTEFACTS)[number];

/** Permitted font container extensions (CONTRACTS §6). */
export const FONT_EXTENSIONS = ["ttf", "otf", "woff2"] as const;

export type FontExtension = (typeof FONT_EXTENSIONS)[number];

function checkedId(kind: string, value: string): string {
  if (!ULID_PATTERN.test(value)) {
    throw new StorageKeyError(`${kind} is not a ULID: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Normalise a file extension: lowercase, no leading dot, alphanumeric only.
 *
 * @throws StorageKeyError when the result is not usable in a key.
 */
export function normaliseExtension(extension: string): string {
  const clean = extension.toLowerCase().replace(/^\.+/, "");
  if (!EXTENSION_PATTERN.test(clean)) {
    throw new StorageKeyError(`${JSON.stringify(extension)} is not a usable file extension`);
  }
  return clean;
}

/** The extension of a client-supplied filename, or `undefined` when it has none. */
export function extensionOf(filename: string): string | undefined {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const candidate = base.slice(dot + 1).toLowerCase();
  return EXTENSION_PATTERN.test(candidate) ? candidate : undefined;
}

/** `ws/{workspaceId}/p/{projectId}/media/{mediaId}` — the prefix both stores share. */
export function mediaPrefix(workspaceId: string, projectId: string, mediaId: string): string {
  return (
    `ws/${checkedId("workspaceId", workspaceId)}` +
    `/p/${checkedId("projectId", projectId)}` +
    `/media/${checkedId("mediaId", mediaId)}`
  );
}

/** Raw upload key, in the S3 bucket. */
export function rawKey(
  workspaceId: string,
  projectId: string,
  mediaId: string,
  extension: string,
): string {
  return `${mediaPrefix(workspaceId, projectId, mediaId)}/raw.${normaliseExtension(extension)}`;
}

/** Derived-media key, in the R2 bucket. */
export function derivedKey(
  workspaceId: string,
  projectId: string,
  mediaId: string,
  artefact: DerivedArtefact,
): string {
  if (!DERIVED_ARTEFACTS.includes(artefact)) {
    throw new StorageKeyError(`${JSON.stringify(artefact)} is not a CONTRACTS §6 artefact`);
  }
  return `${mediaPrefix(workspaceId, projectId, mediaId)}/${artefact}`;
}

/** `thumb-{n}.jpg`, in the R2 bucket. */
export function thumbKey(
  workspaceId: string,
  projectId: string,
  mediaId: string,
  index: number,
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new StorageKeyError("thumbnail index must be a non-negative integer");
  }
  return `${mediaPrefix(workspaceId, projectId, mediaId)}/thumb-${String(index)}.jpg`;
}

/**
 * The imported-subtitle sidecar, in the R2 bucket.
 *
 * CONTRACTS §6 enumerates the derived artefacts a *worker* produces and does not
 * name this one, because an imported subtitle is not derived from the media —
 * it arrives with it (`POST /projects/{id}/import`). It is filed under the same
 * media prefix so one lifecycle rule and one purge sweep cover the lot, and it
 * is deliberately named outside the enumerated set so no reader can mistake it
 * for something `media.proxy` wrote.
 */
export function subtitleKey(workspaceId: string, projectId: string, mediaId: string): string {
  return `${mediaPrefix(workspaceId, projectId, mediaId)}/subtitle.json`;
}

/** Export key, in the R2 bucket (A21 writes these; the shape is fixed here). */
export function exportKey(
  workspaceId: string,
  projectId: string,
  exportId: string,
  extension: string,
): string {
  return (
    `ws/${checkedId("workspaceId", workspaceId)}` +
    `/p/${checkedId("projectId", projectId)}` +
    `/exports/${checkedId("exportId", exportId)}.${normaliseExtension(extension)}`
  );
}

/** Workspace font key, in the R2 bucket (A18b writes these). */
export function fontKey(workspaceId: string, fontId: string, extension: FontExtension): string {
  if (!FONT_EXTENSIONS.includes(extension)) {
    throw new StorageKeyError(`${JSON.stringify(extension)} is not a permitted font extension`);
  }
  return `ws/${checkedId("workspaceId", workspaceId)}/fonts/${checkedId("fontId", fontId)}.${extension}`;
}

/**
 * Brand asset key (watermark, logo), in the R2 bucket (A21 writes these).
 *
 * Added 2026-09-02 after A20: `watermark.assetId` in the signed render manifest
 * names one of these when a workspace deliberately overlays its own logo.
 */
export function brandAssetKey(workspaceId: string, assetId: string): string {
  if (!BRAND_ASSET_ID_PATTERN.test(assetId)) {
    throw new StorageKeyError(
      `assetId is not a ULID or a known asset slug: ${JSON.stringify(assetId)}`,
    );
  }
  return `ws/${checkedId("workspaceId", workspaceId)}/brand/${assetId}.png`;
}

/** Is `key` inside this workspace's namespace? Used before every signed URL. */
export function keyBelongsToWorkspace(key: string, workspaceId: string): boolean {
  return key.startsWith(`ws/${workspaceId}/`);
}
