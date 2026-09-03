/**
 * Audio-pack ingestion end to end (D04a): ingest the synthetic fixture pack
 * against a real, migrated PostgreSQL (pgvector) and a real MinIO, then read
 * the rows back through `AudioAssetsRepository` and `assetAllowed`.
 *
 * Needs Postgres (and MinIO for the derived bucket) exactly as the other
 * `*.e2e-spec.ts` suites do; skips loudly without either.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@montaj/edg";

import {
  createTestDatabase,
  isDatabaseAvailable,
  skipReason,
  type TestDatabase,
} from "./db-harness.js";
import { assetAllowed } from "../src/audio-assets/asset-allowed.js";
import { AudioAssetsRepository } from "../src/audio-assets/audio-assets.repository.js";
import { StubEmbedder } from "../src/audio-assets/embedder.js";
import { measureIntegratedLoudness } from "../src/audio-assets/loudness.js";
import { validateManifest } from "../src/audio-assets/manifest.schema.js";
import { audioPackAssetKey } from "../src/audio-assets/pack-keys.js";
import { S3ObjectStore } from "../src/common/storage/s3-object-store.js";

const available = isDatabaseAvailable();
if (!available) console.warn(`[audio-assets.e2e] skipped: ${skipReason}`);

const FIXTURE_MANIFEST = resolve(__dirname, "../../../fixtures/audio-pack/manifest.json");
const FIXTURE_DIR = resolve(__dirname, "../../../fixtures/audio-pack");

async function ensureBucket(store: S3ObjectStore, client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  void store;
}

describe.skipIf(!available)("audio-assets — ingest, idempotency, retrieval, licence gate", () => {
  let db: TestDatabase;
  let store: S3ObjectStore;
  let repository: AudioAssetsRepository;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`audio-assets suite could not start: ${skipReason}`);
    db = created;
    repository = new AudioAssetsRepository(db.prisma as never);

    store = new S3ObjectStore({
      kind: "r2",
      bucket: "montaj-derived",
      endpoint: "http://localhost:9000",
      region: "ap-south-1",
      accessKeyId: "montaj-local",
      secretAccessKey: "montaj-local-secret",
    });
    const client = new S3Client({
      endpoint: "http://localhost:9000",
      region: "ap-south-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "montaj-local", secretAccessKey: "montaj-local-secret" },
    });
    await ensureBucket(store, client, "montaj-derived");
  }, 60_000);

  afterAll(async () => {
    if (db !== undefined) await db.stop();
  });

  it("ingests every fixture cue, uploads it, and is idempotent on a second pass", async () => {
    const manifest = validateManifest(JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")));
    const embedder = new StubEmbedder();

    const ingestOnce = async () => {
      let created = 0;
      let updated = 0;
      for (const asset of manifest.assets) {
        const filePath = resolve(FIXTURE_DIR, asset.filePath);
        const loudness = await measureIntegratedLoudness({ ffmpegBinary: "ffmpeg", filePath });
        const embedding = await embedder.embed(filePath);
        const storageKey = audioPackAssetKey(manifest.pack.id, asset.id);
        await store.put({
          key: storageKey,
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture path under fixtures/audio-pack, not attacker input -- reviewed for D04a
          body: readFileSync(filePath),
          contentType: "audio/wav",
        });
        const result = await repository.upsertRow({
          id: newId(),
          packId: manifest.pack.id,
          asset,
          storageKey,
          integratedLufs: loudness.integratedLufs,
          truePeakDb: loudness.truePeakDb,
          durationMs: loudness.durationMs,
          embedding,
        });
        if (result.created) created += 1;
        else updated += 1;
      }
      return { created, updated };
    };

    const first = await ingestOnce();
    expect(first.created).toBe(manifest.assets.length);
    expect(first.updated).toBe(0);

    const rowCountAfterFirst = await db.prisma.audioAsset.count();
    expect(rowCountAfterFirst).toBe(manifest.assets.length);

    // Re-ingesting the same manifest must update in place, not duplicate
    // (idempotent by (provider, providerAssetId)).
    const second = await ingestOnce();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(manifest.assets.length);

    const rowCountAfterSecond = await db.prisma.audioAsset.count();
    expect(rowCountAfterSecond).toBe(manifest.assets.length);

    // Loudness was measured for every cue (ffmpeg ran successfully).
    const rows = await db.prisma.audioAsset.findMany({ where: { kind: "sfx" } });
    for (const row of rows) {
      expect(row.integratedLufs).not.toBeNull();
      expect(row.durationMs).not.toBeNull();
      expect(row.storageKey).toMatch(/^packs\/fixture-pack-01\//);
    }
  }, 120_000);

  it("ranks by CLAP (stub) cosine similarity, deterministically, over allowed assets", async () => {
    const embedder = new StubEmbedder();
    const impactPath = resolve(FIXTURE_DIR, "wav/sfx-impact-01.wav");
    const queryEmbedding = await embedder.embed(impactPath);

    const rankedOnce = await repository.findRankedByEmbedding({ kind: "sfx", queryEmbedding });
    const rankedTwice = await repository.findRankedByEmbedding({ kind: "sfx", queryEmbedding });

    expect(rankedOnce.length).toBeGreaterThan(0);
    // Determinism: same query, same order, every time.
    expect(rankedOnce.map((r) => r.id)).toEqual(rankedTwice.map((r) => r.id));
    // The nearest neighbour of the impact cue's own embedding is itself
    // (distance ~0), since the stub embedder is a deterministic function of
    // file bytes.
    expect(rankedOnce[0]?.distance).toBeLessThan(0.01);

    // Every ranked row passes the licence predicate for a fixture-owned pack
    // on every surface (fixture pack sets allowsRawFileDelivery true, WORLD
    // territory, clearanceMethod none, provider owned).
    for (const row of rankedOnce) {
      const result = assetAllowed(row, { surface: "desktop", plan: "free", territory: "IN" });
      expect(result.allowed).toBe(true);
    }
  }, 60_000);
});
