/**
 * Audio-pack ingestion end to end (D04a): ingest the synthetic fixture pack
 * against a real, migrated PostgreSQL (pgvector) and a real MinIO, then read
 * the rows back through `AudioAssetsRepository` and `assetAllowed`.
 *
 * Needs Postgres (and MinIO for the derived bucket) exactly as the other
 * `*.e2e-spec.ts` suites do; skips loudly without either.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@montaj/edg";

import {
  createTestDatabase,
  isDatabaseAvailable,
  skipReason,
  type TestDatabase,
} from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { assetAllowed } from "../src/audio-assets/asset-allowed.js";
import { AudioAssetsRepository } from "../src/audio-assets/audio-assets.repository.js";
import { StubEmbedder } from "../src/audio-assets/embedder.js";
import { measureIntegratedLoudness } from "../src/audio-assets/loudness.js";
import { validateManifest } from "../src/audio-assets/manifest.schema.js";
import { audioPackAssetKey } from "../src/audio-assets/pack-keys.js";
import { TokenService } from "../src/auth/token.service.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { S3ObjectStore } from "../src/common/storage/s3-object-store.js";
import { resetEnvCache } from "../src/config/config.module.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

import type { INestApplication } from "@nestjs/common";

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

  it("findCatalogueWithEmbeddings recovers packId and a 512-dim embedding per row (D04c)", async () => {
    const rows = await repository.findCatalogueWithEmbeddings("sfx");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.packId).toBe("fixture-pack-01");
      expect(row.embedding).toHaveLength(512);
      expect(row.licenceSnapshot["provider"]).toBe("owned");
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// GET /audio-assets/{assetId}/url (D04d) — the whole HTTP path, against a
// real, migrated Postgres, a real Redis (`RateLimitGuard` needs one) and a
// real MinIO: mint a token, fetch the signed URL, and prove the bytes it
// resolves to are the fixture cue's own bytes — the same "don't fake the
// presign" stance `fonts.e2e-spec.ts` documents.
// ---------------------------------------------------------------------------

const REDIS_READY = isRedisAvailable();
const HTTP_CAN_RUN = available && REDIS_READY;
if (!HTTP_CAN_RUN) {
  console.warn(
    `[audio-assets.e2e http] skipped — ${available ? "" : `database: ${skipReason}. `}` +
      `${REDIS_READY ? "" : `redis: ${redisSkipReason}.`}`,
  );
}

const JWT_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const HTTP_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function httpId(kind: string, run: string): string {
  return `01JE${kind}${run}`.padEnd(26, "0").slice(0, 26);
}

describe.skipIf(!HTTP_CAN_RUN)("GET /audio-assets/{assetId}/url — HTTP, real infra", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let store: S3ObjectStore;
  let redis: IORedis;
  let app: INestApplication;
  let tokens: TokenService;

  const run = Date.now().toString(36).toUpperCase().padStart(10, "0").slice(-10);
  const USER = httpId("US3R", run);
  const WORKSPACE = httpId("WKSP", run);
  const ASSET_OWNED = httpId("ASS1", run);
  const ASSET_PARTNER_NO_CLEARANCE = httpId("ASS2", run);
  let ownedStorageKey: string;

  function token(): string {
    return tokens.mintAccessToken({
      userId: USER,
      workspaceId: WORKSPACE,
      role: "viewer",
      kind: "web",
    }).accessToken;
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`could not start a test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;

    store = new S3ObjectStore({
      kind: "r2",
      bucket: "montaj-derived",
      endpoint: "http://localhost:9000",
      region: "ap-south-1",
      accessKeyId: "montaj-local",
      secretAccessKey: "montaj-local-secret",
    });
    const s3Client = new S3Client({
      endpoint: "http://localhost:9000",
      region: "ap-south-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "montaj-local", secretAccessKey: "montaj-local-secret" },
    });
    await ensureBucket(store, s3Client, "montaj-derived");

    ownedStorageKey = audioPackAssetKey("fixture-pack-http", "owned-01");
    const bytes = readFileSync(resolve(FIXTURE_DIR, "wav/sfx-impact-01.wav"));
    await store.put({ key: ownedStorageKey, body: bytes, contentType: "audio/wav" });

    await prisma.user.create({
      data: { id: USER, email: `audio-assets-http+${run}@example.test`, name: "D04d test" },
    });
    await prisma.workspace.create({
      data: {
        id: WORKSPACE,
        slug: `audio-assets-http-${run}`.toLowerCase(),
        name: `audio-assets-http-${run}`,
        ownerId: USER,
        billingCountry: "IN",
      },
    });
    await prisma.membership.create({
      data: {
        id: httpId("MBR1", run),
        workspaceId: WORKSPACE,
        userId: USER,
        role: "viewer",
        status: "active",
      },
    });

    const embedder = new StubEmbedder();
    const embedding = await embedder.embed(resolve(FIXTURE_DIR, "wav/sfx-impact-01.wav"));
    const vector = `[${embedding.join(",")}]`;

    await prisma.$executeRaw`
      INSERT INTO audio_assets (
        id, kind, provider, provider_asset_id, catalogue_mode,
        territory, allows_commercial_use, allows_monetisation, allows_paid_ads,
        allows_broadcast, allows_raw_file_delivery, allows_offline_cache,
        allows_embedding_index, allows_ai_training, requires_attribution,
        clearance_method, content_id_registered, requires_usage_report,
        title, tags, mood, storage_key, embedding, created_at, updated_at
      ) VALUES (
        ${ASSET_OWNED}, 'sfx'::"AudioAssetKind", 'owned'::"AudioProvider",
        ${`fixture-pack-http:owned-01`}, 'mirrored'::"CatalogueMode",
        ARRAY['WORLD'], true, true, true, true, true, true, true, false, false,
        'none'::"ClearanceMethod", false, false,
        'HTTP test cue', ARRAY['impact'], ARRAY[]::text[], ${ownedStorageKey},
        ${vector}::vector(512), now(), now()
      )
    `;

    // A partner asset with no clearance path established: `assetAllowed`
    // must refuse it (`clearance-not-established`) regardless of surface —
    // this row proves the endpoint re-checks the predicate rather than
    // trusting any id it is handed.
    await prisma.$executeRaw`
      INSERT INTO audio_assets (
        id, kind, provider, provider_asset_id, catalogue_mode,
        territory, allows_commercial_use, allows_monetisation, allows_paid_ads,
        allows_broadcast, allows_raw_file_delivery, allows_offline_cache,
        allows_embedding_index, allows_ai_training, requires_attribution,
        clearance_method, content_id_registered, requires_usage_report,
        title, tags, mood, storage_key, embedding, created_at, updated_at
      ) VALUES (
        ${ASSET_PARTNER_NO_CLEARANCE}, 'sfx'::"AudioAssetKind", 'epidemic'::"AudioProvider",
        ${`fixture-pack-http:partner-01`}, 'mirrored'::"CatalogueMode",
        ARRAY['WORLD'], true, true, true, true, true, true, true, false, false,
        'none'::"ClearanceMethod", false, false,
        'HTTP test partner cue', ARRAY['impact'], ARRAY[]::text[], ${ownedStorageKey},
        ${vector}::vector(512), now(), now()
      )
    `;

    redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

    process.env["DATABASE_URL"] = db.url;
    process.env["REDIS_URL"] = testRedisUrl();
    process.env["JWT_PRIVATE_KEY"] = JWT_KEYS.privateKey;
    process.env["JWT_PUBLIC_KEY"] = JWT_KEYS.publicKey;
    resetEnvCache();

    const { Test } = await import("@nestjs/testing");
    const { AppModule } = await import("../src/app.module.js");
    const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
    const { setupOpenApi } = await import("../src/openapi.js");
    const { applyInternalBodyLimit } = await import("../src/internal/internal-body-limit.js");

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(
        Object.assign(prisma, {
          ping: async () => undefined,
          withTransaction: async (
            fn: (tx: unknown) => Promise<unknown>,
            options: { timeoutMs?: number; maxWaitMs?: number } = {},
          ) =>
            prisma.$transaction(async (tx) => fn(tx), {
              timeout: options.timeoutMs ?? 10_000,
              maxWait: options.maxWaitMs ?? 5_000,
            }),
        }),
      )
      .overrideProvider(RedisService)
      .useValue({
        client: redis,
        ping: async () => undefined,
        onModuleDestroy: async () => undefined,
      })
      .overrideProvider(REALTIME_BUS)
      .useValue(new InMemoryRealtimeBus(new InMemoryRealtimeBroker()))
      .compile();

    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalFilters(new HttpExceptionFilter());
    applyInternalBodyLimit(app);
    setupOpenApi(app);
    await app.init();
    tokens = app.get(TokenService);
    void HTTP_CROCKFORD;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (db !== undefined) await db.stop();
  });

  it("signs a URL onto an owned, licence-allowed asset, and the URL resolves to the fixture's own bytes", async () => {
    const response = await request(app.getHttpServer())
      .get(`/audio-assets/${ASSET_OWNED}/url`)
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);

    expect(response.body).toMatchObject({ assetId: ASSET_OWNED });
    expect(typeof response.body.url).toBe("string");
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const fetched = await fetch(response.body.url);
    expect(fetched.status).toBe(200);
    const bytes = Buffer.from(await fetched.arrayBuffer());
    expect(bytes.equals(readFileSync(resolve(FIXTURE_DIR, "wav/sfx-impact-01.wav")))).toBe(true);
  });

  it("404s an unknown asset id", async () => {
    await request(app.getHttpServer())
      .get(`/audio-assets/${newId()}/url`)
      .set("Authorization", `Bearer ${token()}`)
      .expect(404);
  });

  it("403s a partner asset with no established clearance, re-checked at signing time", async () => {
    const response = await request(app.getHttpServer())
      .get(`/audio-assets/${ASSET_PARTNER_NO_CLEARANCE}/url`)
      .set("Authorization", `Bearer ${token()}`)
      .expect(403);

    expect(response.body.error.code).toBe("audio-assets/not_allowed");
    expect(response.body.error.details.reasons).toContain("clearance-not-established");
  });

  it("401s with no token", async () => {
    await request(app.getHttpServer()).get(`/audio-assets/${ASSET_OWNED}/url`).expect(401);
  });
});
