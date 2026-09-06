import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Logger } from "@nestjs/common";

import {
  MULTIPART_MAX_PARTS,
  MULTIPART_PART_SIZE_BYTES,
  partCountFor,
  UPLOAD_URL_TTL_SECONDS,
} from "./object-store.js";

import type {
  CompletedPart,
  CreateMultipartInput,
  MultipartUpload,
  ObjectHead,
  ObjectStore,
  PresignedPart,
  PutObjectInput,
} from "./object-store.js";
import type { S3ClientConfig } from "@aws-sdk/client-s3";

export interface S3ObjectStoreConfig {
  readonly kind: "s3" | "r2";
  readonly bucket: string;
  readonly endpoint: string;
  /**
   * Origin used for every presigned URL handed to a browser: GETs, single-shot
   * PUTs and multipart upload parts. Direct, unsigned SDK calls the API makes
   * for itself (head, tag, delete, create/complete multipart) always keep
   * using `endpoint`. SigV4 binds the signature to the host, so this must be
   * the exact origin (scheme, host, port) the browser will hit.
   */
  readonly publicEndpoint?: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Override the part size; the default is tuning, not a contract. */
  readonly partSizeBytes?: number;
}

/** Raised when the store refuses an operation for a reason the caller can act on. */
export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/**
 * {@link ObjectStore} over the AWS SDK v3, against anything S3-compatible: AWS S3
 * (ap-south-1, raw media - THREAT-MODEL T24), Cloudflare R2 (derived objects) and
 * MinIO (both, in development).
 *
 * Two client settings are load-bearing rather than cosmetic:
 *
 * - `forcePathStyle` - R2 and MinIO address a bucket as `/{bucket}/{key}`, not as
 *   a virtual host. Without it every request goes to a hostname that does not
 *   resolve locally.
 * - `requestChecksumCalculation: "WHEN_REQUIRED"` - since v3.729 the SDK adds a
 *   CRC32 checksum header to uploads by default. A **presigned** URL cannot carry
 *   one, because the client that PUTs the bytes is a browser that never sees the
 *   SDK: the signature would cover a header the browser does not send, and every
 *   part upload fails with `SignatureDoesNotMatch`. Integrity is still covered -
 *   the store verifies each part ETag and the completion call lists them all.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly logger = new Logger(S3ObjectStore.name);
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly partSizeBytes: number;

  readonly bucket: string;
  readonly kind: "s3" | "r2";

  constructor(config: S3ObjectStoreConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.kind = config.kind;
    this.partSizeBytes = config.partSizeBytes ?? MULTIPART_PART_SIZE_BYTES;
    const clientOptions: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    };
    this.client = client ?? new S3Client(clientOptions);
    this.presignClient =
      config.publicEndpoint === undefined || config.publicEndpoint === config.endpoint
        ? this.client
        : new S3Client({ ...clientOptions, endpoint: config.publicEndpoint });
  }

  async createMultipartUpload(input: CreateMultipartInput): Promise<MultipartUpload> {
    const partCount = partCountFor(input.sizeBytes, this.partSizeBytes);
    if (partCount > MULTIPART_MAX_PARTS) {
      throw new ObjectStoreError(
        `${String(input.sizeBytes)} bytes needs ${String(partCount)} parts; the limit is ${String(
          MULTIPART_MAX_PARTS,
        )}`,
      );
    }

    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.key,
        ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
        ...(input.tags === undefined ? {} : { Tagging: encodeTags(input.tags) }),
      }),
    );
    const uploadId = created.UploadId;
    if (uploadId === undefined) {
      throw new ObjectStoreError(`${this.bucket} returned no upload id for ${input.key}`);
    }

    const ttl = input.expiresInSeconds ?? UPLOAD_URL_TTL_SECONDS;
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const url = await getSignedUrl(
        this.presignClient,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: input.key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttl },
      );
      parts.push({ partNumber, url });
    }

    return {
      key: input.key,
      uploadId,
      partSizeBytes: this.partSizeBytes,
      parts,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<{ etag?: string }> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const result = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
    return result.ETag === undefined ? {} : { etag: result.ETag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      // An upload already completed, aborted or expired is gone, which is the
      // state the caller asked for.
      this.logger.debug({ key, uploadId, err: describe(error) }, "multipart abort ignored");
    }
  }

  async presignGet(
    key: string,
    expiresInSeconds: number,
    options: { readonly downloadFilename?: string } = {},
  ): Promise<string> {
    const disposition =
      options.downloadFilename === undefined
        ? undefined
        : `attachment; filename="${sanitiseFilename(options.downloadFilename)}"`;
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(disposition === undefined ? {} : { ResponseContentDisposition: disposition }),
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignPut(key: string, expiresInSeconds: number, contentType?: string): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(contentType === undefined ? {} : { ContentType: contentType }),
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: Number(result.ContentLength ?? 0),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
        ...(result.ETag === undefined ? {} : { etag: result.ETag }),
        ...(result.LastModified === undefined ? {} : { lastModified: result.LastModified }),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new ObjectStoreError(`could not stat ${this.bucket}/${key}`, error);
    }
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body,
        ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
        ...(input.tags === undefined ? {} : { Tagging: encodeTags(input.tags) }),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = result.Body;
    if (body === undefined) throw new ObjectStoreError(`${this.bucket}/${key} has no body`);
    try {
      const bytes = await (
        body as unknown as { transformToByteArray: () => Promise<Uint8Array> }
      ).transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      throw new ObjectStoreError(`could not read ${this.bucket}/${key}`, error);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    let deleted = 0;
    // `DeleteObjects` takes at most 1 000 keys per call.
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // With `Quiet: true` the store reports only failures, so a silent response
      // means the whole batch went.
      deleted += batch.length - (result.Errors?.length ?? 0);
    }
    return deleted;
  }

  async tag(key: string, tags: Readonly<Record<string, string>>): Promise<void> {
    await this.client.send(
      new PutObjectTaggingCommand({
        Bucket: this.bucket,
        Key: key,
        Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
  }
}

/** `a=b&c=d`, URL-encoded, which is what the `x-amz-tagging` header expects. */
export function encodeTags(tags: Readonly<Record<string, string>>): string {
  return Object.entries(tags)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Quotes and control characters out of a `Content-Disposition` filename. */
function sanitiseFilename(filename: string): string {
  return filename.replace(/[^\w. \-()[\]]/g, "_").slice(0, 200);
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    named.name === "NotFound" ||
    named.name === "NoSuchKey" ||
    named.$metadata?.httpStatusCode === 404
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
