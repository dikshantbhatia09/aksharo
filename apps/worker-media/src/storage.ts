import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { Env } from "@montaj/config";

import { transientFailure } from "./errors.js";

/**
 * The two buckets of CONTRACTS §6, from the worker's side.
 *
 * The worker only ever does two things with a store: **presign a read** of the
 * raw object so ffmpeg can stream it, and **upload a derived file** it has just
 * written. There is no `head`, no `delete`, no multipart — a worker that could
 * delete an object is a worker whose stolen credentials can delete a customer's
 * footage.
 *
 * `forcePathStyle` and `requestChecksumCalculation: "WHEN_REQUIRED"` are the same
 * two settings the API's `S3ObjectStore` explains at length: R2 and MinIO address
 * a bucket as `/{bucket}/{key}`, and a presigned URL cannot carry the CRC32 header
 * the SDK adds by default.
 *
 * **Uploads stream from disk.** `PutObjectCommand` is given a read stream and an
 * explicit `ContentLength` from `stat`, so a 200 MB proxy goes out in chunks. Hand
 * it a stream without a length and the SDK buffers the whole body to compute one.
 */

export interface ObjectStore {
  readonly bucket: string;
  readonly kind: "s3" | "r2";
  /** A short-lived GET URL for ffmpeg to read through. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** Upload a file from the job's scratch directory. Returns its size in bytes. */
  putFile(input: {
    readonly key: string;
    readonly file: string;
    readonly contentType: string;
    readonly tags?: Readonly<Record<string, string>>;
  }): Promise<number>;
  /** Upload a small in-memory body — `waveform.json`, and nothing else. */
  putBody(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly tags?: Readonly<Record<string, string>>;
  }): Promise<number>;
}

export interface StoreConfig {
  readonly kind: "s3" | "r2";
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Tag every derived object, so the bucket's lifecycle rule can select them (D47). */
export const DERIVED_OBJECT_TAGS: Readonly<Record<string, string>> = { montaj: "derived" };

export class S3Store implements ObjectStore {
  private readonly client: S3Client;
  readonly bucket: string;
  readonly kind: "s3" | "r2";

  constructor(config: StoreConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.kind = config.kind;
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error) {
      throw transientFailure("media/store_unavailable", "Could not sign a read of the source.", {
        cause: error,
      });
    }
  }

  async putFile(input: {
    readonly key: string;
    readonly file: string;
    readonly contentType: string;
    readonly tags?: Readonly<Record<string, string>>;
  }): Promise<number> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const { size } = await stat(input.file);
    await this.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
        Body: createReadStream(input.file),
        ContentLength: size,
        ContentType: input.contentType,
        ...(input.tags === undefined ? {} : { Tagging: encodeTags(input.tags) }),
      }),
      input.key,
    );
    return size;
  }

  async putBody(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly tags?: Readonly<Record<string, string>>;
  }): Promise<number> {
    await this.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
        ...(input.tags === undefined ? {} : { Tagging: encodeTags(input.tags) }),
      }),
      input.key,
    );
    return input.body.byteLength;
  }

  private async send(command: PutObjectCommand, key: string): Promise<void> {
    try {
      await this.client.send(command);
    } catch (error) {
      // Always retryable: a failed write is the store's problem, and the job's
      // outputs are idempotent — a retry overwrites the same keys.
      throw transientFailure("media/store_unavailable", `Could not write ${key}.`, {
        cause: error,
      });
    }
  }
}

/** Build both stores from the validated environment (CONTRACTS §1). */
export function storesFrom(env: Env): { raw: ObjectStore; derived: ObjectStore } {
  return {
    raw: new S3Store({
      kind: "s3",
      bucket: env.S3_BUCKET_RAW,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    }),
    derived: new S3Store({
      kind: "r2",
      bucket: env.R2_BUCKET_DERIVED,
      endpoint: env.R2_ENDPOINT,
      // R2 has one region and calls it `auto`; MinIO takes whatever it is given.
      // Reusing `S3_REGION` keeps SigV4 happy against both.
      region: env.S3_REGION,
      accessKeyId: env.R2_ACCESS_KEY,
      secretAccessKey: env.R2_SECRET_KEY,
    }),
  };
}

/** `a=b&c=d`, URL-encoded — S3's `Tagging` header format. */
export function encodeTags(tags: Readonly<Record<string, string>>): string {
  return Object.entries(tags)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Content types for the CONTRACTS §6 artefacts. */
export const DERIVED_CONTENT_TYPES = {
  "proxy540.mp4": "video/mp4",
  "audio16k.wav": "audio/wav",
  "audio48k.wav": "audio/wav",
  "waveform.json": "application/json",
  thumb: "image/jpeg",
} as const;
