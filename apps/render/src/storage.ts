/**
 * Object-store access and the storage keys of `docs/CONTRACTS.md` §6.
 *
 * ```
 * raw     (S3) ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}
 * derived (R2) ws/{workspaceId}/p/{projectId}/media/{mediaId}/{audio48k.wav|proxy540.mp4|…}
 * exports (R2) ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}
 * fonts   (R2) ws/{workspaceId}/fonts/{fontId}.{ttf|otf|woff2}
 * ```
 *
 * The render service **reads** raw media (full quality) or the derived proxy
 * (preview renders), and **writes** exports. It never writes to the raw bucket.
 *
 * The narrow {@link ObjectStore} interface, not the AWS SDK, is what the rest of
 * the app is written against: it makes every test a fake instead of a container,
 * and it keeps the SDK import inside one function so `import "./storage.js"`
 * stays cheap.
 *
 * Ids are validated before they are pasted into a key. They arrive from a job
 * payload, and a key is a path — an id with a `/` in it would be a way out of the
 * workspace's own prefix (THREAT-MODEL: tenant isolation).
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

/** ULIDs are Crockford base32, 26 characters (CONTRACTS §0). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EXTENSION = /^[a-z0-9]{1,8}$/;

export class StorageError extends Error {
  public override readonly name = "StorageError";
  constructor(
    readonly code: "storage/bad-key" | "storage/unreadable" | "storage/unwritable",
    message: string,
  ) {
    super(message);
  }
}

function checked(kind: string, value: string): string {
  if (!ULID.test(value)) {
    throw new StorageError("storage/bad-key", `${kind} is not a ULID: ${JSON.stringify(value)}`);
  }
  return value;
}

function checkedExtension(ext: string): string {
  const clean = ext.toLowerCase().replace(/^\./, "");
  if (!EXTENSION.test(clean)) {
    throw new StorageError("storage/bad-key", `${JSON.stringify(ext)} is not a usable extension`);
  }
  return clean;
}

/** `ws/{workspaceId}/p/{projectId}/media/{mediaId}` — the shared prefix. */
export function mediaPrefix(workspaceId: string, projectId: string, mediaId: string): string {
  return `ws/${checked("workspaceId", workspaceId)}/p/${checked("projectId", projectId)}/media/${checked("mediaId", mediaId)}`;
}

export function rawKey(
  workspaceId: string,
  projectId: string,
  mediaId: string,
  ext: string,
): string {
  return `${mediaPrefix(workspaceId, projectId, mediaId)}/raw.${checkedExtension(ext)}`;
}

/** Export key in the R2 bucket. */
export function exportKey(
  workspaceId: string,
  projectId: string,
  exportId: string,
  ext: string,
): string {
  return `ws/${checked("workspaceId", workspaceId)}/p/${checked("projectId", projectId)}/exports/${checked("exportId", exportId)}.${checkedExtension(ext)}`;
}

/**
 * Key for a subtitle sidecar.
 *
 * CONTRACTS §6 gives exports one key per `exportId`, and a subtitle job produces
 * several files from one export (SRT and VTT, Roman and native). The suffix goes
 * **before** the extension — `{exportId}.roman.srt` — so every sidecar is still
 * `ws/…/exports/{exportId}.{ext}` to anything matching on the prefix, and the
 * contract's shape is unchanged.
 */
export function subtitleKey(
  workspaceId: string,
  projectId: string,
  exportId: string,
  script: string,
  ext: string,
): string {
  if (!/^[a-z0-9]{1,16}$/.test(script)) {
    throw new StorageError("storage/bad-key", `${JSON.stringify(script)} is not a script tag`);
  }
  return `ws/${checked("workspaceId", workspaceId)}/p/${checked("projectId", projectId)}/exports/${checked("exportId", exportId)}.${script}.${checkedExtension(ext)}`;
}

/**
 * Key of a brand asset — the watermark a manifest names.
 *
 * CONTRACTS §6 names raw media, derived media, exports and fonts; it has no row
 * for the mark burned into a free-tier render. The prefix here follows the same
 * shape as the fonts one (`ws/{workspaceId}/…`), so it is per-workspace and
 * inside the tenant's own path, and A21 writes to it when it issues a manifest
 * with a watermark. Reported as an addition rather than assumed to be covered.
 */
export function brandAssetKey(workspaceId: string, assetId: string, ext = "png"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId)) {
    throw new StorageError("storage/bad-key", `${JSON.stringify(assetId)} is not an asset id`);
  }
  return `ws/${checked("workspaceId", workspaceId)}/brand/${assetId}.${checkedExtension(ext)}`;
}

export interface PutOptions {
  readonly contentType?: string;
}

/** The slice of an S3-compatible client this service uses. */
export interface ObjectStore {
  readonly bucket: string;
  /** Fetch one object to a local path, creating parent directories. */
  download(key: string, destination: string): Promise<string>;
  /** Upload a local file. Returns its size in bytes. */
  upload(key: string, source: string, options?: PutOptions): Promise<number>;
  /** Upload bytes already in memory. Returns their size. */
  putBytes(key: string, bytes: Uint8Array, options?: PutOptions): Promise<number>;
  /** Read a whole object into memory — watermark assets and fonts only. */
  getBytes(key: string): Promise<Uint8Array>;
}

export interface BucketConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Blank uses the AWS default credential chain (IRSA). See below. */
  readonly accessKey?: string;
  readonly secretKey?: string;
}

/**
 * An S3-compatible bucket (R2, MinIO, AWS).
 *
 * Path-style addressing and SigV4: R2 requires both, MinIO wants both, and AWS
 * accepts both — one configuration for every environment the service runs in.
 */
export async function createObjectStore(config: BucketConfig): Promise<ObjectStore> {
  if (config.endpoint === "" || config.bucket === "") {
    throw new StorageError(
      "storage/unreadable",
      "object store is not configured: endpoint, bucket and credentials are all required",
    );
  }
  // Imported here so `import "./storage.js"` does not pull the SDK into a test
  // that only builds keys.
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
  // Omit `credentials` entirely when none are configured, so the SDK walks its
  // default chain (IRSA / pod identity). Empty strings would disable it (P0-09).
  const credentials =
    config.accessKey !== undefined &&
    config.accessKey !== "" &&
    config.secretKey !== undefined &&
    config.secretKey !== ""
      ? { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }
      : undefined;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    ...(credentials === undefined ? {} : { credentials }),
    forcePathStyle: true,
  });

  const bodyOf = async (key: string): Promise<NodeJS.ReadableStream> => {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (response.Body === undefined) {
        throw new Error("the object has no body");
      }
      return response.Body as NodeJS.ReadableStream;
    } catch (error) {
      throw new StorageError(
        "storage/unreadable",
        `could not read ${config.bucket}/${key}: ${messageOf(error)}`,
      );
    }
  };

  return {
    bucket: config.bucket,

    async download(key, destination) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      await mkdir(dirname(destination), { recursive: true });
      const body = await bodyOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      await pipeline(body, createWriteStream(destination));
      return destination;
    },

    async getBytes(key) {
      const body = await bodyOf(key);
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        // A stream in object mode can yield a string; `Buffer.from` handles both,
        // and the union has to be widened for TypeScript to accept the call.
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
      }
      return new Uint8Array(Buffer.concat(chunks));
    },

    async upload(key, source, options) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const info = await stat(source);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
            Body: createReadStream(source),
            ContentLength: info.size,
            ...(options?.contentType === undefined ? {} : { ContentType: options.contentType }),
          }),
        );
      } catch (error) {
        throw new StorageError(
          "storage/unwritable",
          `could not write ${config.bucket}/${key}: ${messageOf(error)}`,
        );
      }
      return info.size;
    },

    async putBytes(key, bytes, options) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: Buffer.from(bytes),
            ContentLength: bytes.byteLength,
            ...(options?.contentType === undefined ? {} : { ContentType: options.contentType }),
          }),
        );
      } catch (error) {
        throw new StorageError(
          "storage/unwritable",
          `could not write ${config.bucket}/${key}: ${messageOf(error)}`,
        );
      }
      return bytes.byteLength;
    },
  };
}

/** Content types for the artefacts this service writes. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  ass: "text/x-ssa",
});

export function contentTypeFor(extension: string): string {
  return CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
