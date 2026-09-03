import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { MediaJobError } from "./errors.js";
import {
  DERIVED_CONTENT_TYPES,
  DERIVED_OBJECT_TAGS,
  S3Store,
  encodeTags,
  storesFrom,
} from "./storage.js";

import type { S3Client } from "@aws-sdk/client-s3";

const CONFIG = {
  kind: "r2",
  bucket: "montaj-derived",
  endpoint: "http://localhost:9000",
  region: "ap-south-1",
  accessKeyId: "montaj-local",
  secretAccessKey: "montaj-local-secret",
} as const;

/** A client that records what it was sent, in place of the network. */
function recordingClient(behaviour: () => void = () => undefined): {
  client: S3Client;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const client = {
    send: vi.fn(async (command: { input: Record<string, unknown> }) => {
      sent.push(command.input);
      behaviour();
      return {};
    }),
  } as unknown as S3Client;
  return { client, sent };
}

let dir = "";
let file = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "montaj-storage-test-"));
  file = join(dir, "proxy540.mp4");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  await writeFile(file, Buffer.alloc(2_048, 7));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("encodeTags", () => {
  it("produces the `a=b&c=d` S3 wants, URL-encoded", () => {
    expect(encodeTags({ montaj: "derived" })).toBe("montaj=derived");
    expect(encodeTags({ "a b": "c&d" })).toBe("a%20b=c%26d");
    expect(encodeTags({})).toBe("");
  });
});

describe("S3Store.presignGet", () => {
  it("signs a URL locally — no network, and the key is in the path", async () => {
    // Path style, because R2 and MinIO address a bucket as `/{bucket}/{key}`.
    const store = new S3Store(CONFIG);
    const url = await store.presignGet("ws/a/p/b/media/c/raw.mp4", 3_600);
    expect(url).toContain("/montaj-derived/ws/a/p/b/media/c/raw.mp4");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  it("honours the TTL it is given rather than a default", async () => {
    const store = new S3Store(CONFIG);
    expect(await store.presignGet("k", 60)).toContain("X-Amz-Expires=60");
  });
});

describe("S3Store.putFile", () => {
  it("streams from disk with an explicit length, so nothing is buffered", async () => {
    // Hand `PutObjectCommand` a stream without a ContentLength and the SDK reads
    // the whole body into memory to compute one — on a 200 MB proxy.
    const { client, sent } = recordingClient();
    const store = new S3Store(CONFIG, client);
    const size = await store.putFile({
      key: "ws/a/p/b/media/c/proxy540.mp4",
      file,
      contentType: DERIVED_CONTENT_TYPES["proxy540.mp4"],
      tags: DERIVED_OBJECT_TAGS,
    });

    expect(size).toBe(2_048);
    expect(sent[0]).toMatchObject({
      Bucket: "montaj-derived",
      Key: "ws/a/p/b/media/c/proxy540.mp4",
      ContentLength: 2_048,
      ContentType: "video/mp4",
      Tagging: "montaj=derived",
    });
    expect(sent[0]?.["Body"]).toBeDefined();
  });

  it("turns a store failure into a retryable MediaJobError", async () => {
    // A failed write is the store's problem, and the outputs are idempotent: a
    // retry overwrites the same keys.
    const { client } = recordingClient(() => {
      throw new Error("SlowDown");
    });
    const store = new S3Store(CONFIG, client);
    const error = await store
      .putFile({ key: "k", file, contentType: "video/mp4" })
      .catch((caught: unknown) => caught as MediaJobError);
    expect(error).toBeInstanceOf(MediaJobError);
    if (!(error instanceof MediaJobError)) throw error;
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/store_unavailable");
  });
});

describe("S3Store.putBody", () => {
  it("writes a small in-memory object with its length", async () => {
    const { client, sent } = recordingClient();
    const store = new S3Store(CONFIG, client);
    const body = Buffer.from('{"peaks":[]}', "utf8");
    const size = await store.putBody({
      key: "ws/a/p/b/media/c/waveform.json",
      body,
      contentType: DERIVED_CONTENT_TYPES["waveform.json"],
    });
    expect(size).toBe(body.byteLength);
    expect(sent[0]).toMatchObject({
      ContentLength: body.byteLength,
      ContentType: "application/json",
    });
  });

  it("reports a failed write as retryable too", async () => {
    const { client } = recordingClient(() => {
      throw new Error("no");
    });
    const store = new S3Store(CONFIG, client);
    await expect(
      store.putBody({ key: "k", body: new Uint8Array([1]), contentType: "application/json" }),
    ).rejects.toBeInstanceOf(MediaJobError);
  });
});

describe("storesFrom", () => {
  it("builds the raw bucket on S3 and the derived one on R2 (CONTRACTS §6)", () => {
    // Two systems, not one store with a bucket argument: a proxy written into the
    // residency bucket by a typo is what the split prevents.
    const env = {
      S3_ENDPOINT: "http://localhost:9000",
      S3_REGION: "ap-south-1",
      S3_BUCKET_RAW: "montaj-raw",
      S3_ACCESS_KEY: "a",
      S3_SECRET_KEY: "b",
      R2_ENDPOINT: "http://localhost:9000",
      R2_BUCKET_DERIVED: "montaj-derived",
      R2_ACCESS_KEY: "c",
      R2_SECRET_KEY: "d",
    } as unknown as Env;

    const { raw, derived } = storesFrom(env);
    expect(raw.kind).toBe("s3");
    expect(raw.bucket).toBe("montaj-raw");
    expect(derived.kind).toBe("r2");
    expect(derived.bucket).toBe("montaj-derived");
  });
});

describe("DERIVED_CONTENT_TYPES", () => {
  it("names a type for every CONTRACTS §6 artefact the worker writes", () => {
    expect(DERIVED_CONTENT_TYPES).toEqual({
      "proxy540.mp4": "video/mp4",
      "audio16k.wav": "audio/wav",
      "audio48k.wav": "audio/wav",
      "waveform.json": "application/json",
      thumb: "image/jpeg",
    });
  });
});
