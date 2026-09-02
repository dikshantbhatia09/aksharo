/**
 * The object-store port.
 *
 * Two instances exist ({@link RAW_STORE} on S3, {@link DERIVED_STORE} on R2),
 * both S3-compatible and both MinIO in development. Feature code depends on this
 * interface and never on the AWS SDK, so a test can hand a module a fake in one
 * line and the SDK never has to be mocked.
 *
 * **Bytes never pass through the API.** Uploads go straight to the store through
 * presigned multipart URLs and downloads through short-lived presigned GETs; the
 * API only ever issues signatures, heads, tags and deletes. That is what keeps a
 * 2 GB upload from occupying a Node process for ten minutes, and it is why the
 * interface has no `putStream`.
 */

/** One part of a multipart upload, with the URL the browser PUTs it to. */
export interface PresignedPart {
  readonly partNumber: number;
  readonly url: string;
}

/** A part the client has uploaded, as returned by S3 in the `ETag` header. */
export interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  readonly partSizeBytes: number;
  readonly parts: readonly PresignedPart[];
  /** ISO-8601 instant after which every URL above stops working. */
  readonly expiresAt: string;
}

export interface ObjectHead {
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: Date;
}

export interface CreateMultipartInput {
  readonly key: string;
  /** Declared total size; decides how many parts are signed. */
  readonly sizeBytes: number;
  readonly contentType?: string;
  /** How long the part URLs stay valid, in seconds. */
  readonly expiresInSeconds?: number;
  /** Objects the lifecycle rules key their expiry off (`raw`, `derived`, ...). */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * One configured bucket.
 *
 * Every method takes a key that has already been built by `storage.keys.ts`; no
 * implementation is allowed to interpolate an id into a path itself.
 */
export interface ObjectStore {
  /** Which bucket this instance writes to; carried into `media_assets.bucket`. */
  readonly bucket: string;
  /** `s3` or `r2` — the `StorageBucket` value that names this store in the schema. */
  readonly kind: "s3" | "r2";

  /** Begin a multipart upload and presign every part. */
  createMultipartUpload(input: CreateMultipartInput): Promise<MultipartUpload>;

  /** Finish one, in part order. Returns the final object's ETag when the store gives one. */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<{ readonly etag?: string }>;

  /** Give up on one. Best effort: an upload that is already gone is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /** A short-lived GET URL. Callers pass a TTL; nothing here defaults to "long". */
  presignGet(
    key: string,
    expiresInSeconds: number,
    options?: { readonly downloadFilename?: string },
  ): Promise<string>;

  /** A single-shot PUT URL, for objects small enough not to need multipart. */
  presignPut(key: string, expiresInSeconds: number, contentType?: string): Promise<string>;

  /** Object metadata, or `null` when it does not exist. */
  head(key: string): Promise<ObjectHead | null>;

  /** Write a small object from the API process (the imported subtitle sidecar). */
  put(input: PutObjectInput): Promise<void>;

  /** Read a small object back into memory. Tests and the import path only. */
  get(key: string): Promise<Buffer>;

  /** Delete one object. Deleting something absent is a success. */
  delete(key: string): Promise<void>;

  /** Delete many. Returns how many the store reported deleted. */
  deleteMany(keys: readonly string[]): Promise<number>;

  /** Replace an object's tag set — how retention lifecycle rules select objects. */
  tag(key: string, tags: Readonly<Record<string, string>>): Promise<void>;
}

/** DI token for the raw (S3) bucket: original uploads, `S3_BUCKET_RAW`. */
export const RAW_STORE = Symbol("MONTAJ_RAW_STORE");

/** DI token for the derived (R2) bucket: proxies, audio, waveforms, thumbs. */
export const DERIVED_STORE = Symbol("MONTAJ_DERIVED_STORE");

/**
 * Multipart part size.
 *
 * 16 MiB, from the brief. S3 requires every part but the last to be at least
 * 5 MiB and allows at most 10 000 of them, so 16 MiB tops out at 160 GB — far
 * beyond any plan's `maxFileBytes` — while keeping the part count (and therefore
 * the number of signatures in an `init` response) small for ordinary uploads.
 */
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;

/** S3's hard limit on parts in one multipart upload. */
export const MULTIPART_MAX_PARTS = 10_000;

/** How long an upload's part URLs stay valid: long enough for a slow connection. */
export const UPLOAD_URL_TTL_SECONDS = 60 * 60;

/** How long a derived-object download URL stays valid (brief §1: 5 minutes). */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** How many parts a `sizeBytes` upload needs at {@link MULTIPART_PART_SIZE_BYTES}. */
export function partCountFor(
  sizeBytes: number,
  partSizeBytes: number = MULTIPART_PART_SIZE_BYTES,
): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 1;
  return Math.max(1, Math.ceil(sizeBytes / partSizeBytes));
}
