/**
 * A booted API with a real PostgreSQL and a real Redis, seeded with one project
 * that has a transcript and an EDG document.
 *
 * The EDG cannot be tested against substituted infrastructure and still prove
 * anything: the compare-and-swap is a `SELECT … FOR UPDATE` plus a conditional
 * `UPDATE`, the segment order is a `text COLLATE "C"` index, the idempotency
 * check is a GIN array overlap and the rate limiter is a Lua script. Every one of
 * those is the database's behaviour, not ours.
 *
 * A23a: the services are the run's, not this suite's. `test/global-setup.ts`
 * starts one PostgreSQL and one Redis for the whole run; this harness clones the
 * migrated template into a database of its own and uses the logical Redis database
 * this suite owns, and the suite skips loudly when neither Docker nor
 * `TEST_DATABASE_URL` is available, exactly as `database.e2e-spec.ts` does.
 */
import { generateKeyPairSync } from "node:crypto";

import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

import { newId } from "@montaj/edg";
import { type Segment, type TranscriptChunk, type Word } from "@montaj/edg/schemas";
import { seqBetween } from "@montaj/edg/seq";

import { createTestDatabase, type TestDatabase } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { AppModule } from "../src/app.module.js";
import { TokenService } from "../src/auth/token.service.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { RATE_LIMIT_PREFIX } from "../src/common/guards/index.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { EDG_OPS_BUCKET } from "../src/edg/edg.rate-limit.js";
import { EdgService } from "../src/edg/edg.service.js";
import { setupOpenApi } from "../src/openapi.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

import type { INestApplication } from "@nestjs/common";
import type { $Enums } from "@prisma/client";

export interface SeededProject {
  readonly projectId: string;
  readonly edgId: string;
  readonly transcriptId: string;
  readonly mediaId: string;
  readonly revision: number;
  readonly segments: Segment[];
  readonly chunks: TranscriptChunk[];
}

export interface EdgTestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly port: number;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly userId: string;
  /** An access token for the seeded workspace at the given role. */
  token(role?: $Enums.MembershipRole, workspaceId?: string): string;
  /** A fresh project with a transcript, an EDG document and `segments` captions. */
  seed(options?: {
    words?: number;
    chunkSize?: number;
    workspaceId?: string;
  }): Promise<SeededProject>;
  /** Refill the workspace's op-batch budget, so a loop is not throttled. */
  resetBudget(workspaceId?: string): Promise<void>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/** Why the suite was skipped, for the console message. */
export let edgSkipReason = "";

/** A throwaway RS256 pair; `setup-env.ts` ships placeholder PEM text on purpose. */
function generateJwtKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

/** A Hinglish-ish transcript: `words` words spread over 10-minute chunks. */
export function buildTranscript(words: number, chunkSize: number): TranscriptChunk[] {
  const vocabulary = ["yaar", "matlab", "bilkul", "sahi", "hai", "dekho", "abhi", "chalo"];
  const chunks: TranscriptChunk[] = [];
  const perWordMs = 400;

  for (let start = 0; start < words; start += chunkSize) {
    const chunkIdx = Math.floor(start / chunkSize);
    const chunkStartMs = chunkIdx * chunkSize * perWordMs;
    const list: Word[] = [];
    for (let n = 0; n < Math.min(chunkSize, words - start); n += 1) {
      const at = chunkStartMs + n * perWordMs;
      list.push({
        wid: `${chunkIdx}:${n}` as Word["wid"],
        s: at,
        e: at + perWordMs - 60,
        t: vocabulary[(start + n) % vocabulary.length] as string,
        sp: (start + n) % 40 < 20 ? "s1" : "s2",
      });
    }
    chunks.push({
      chunkIdx,
      startMs: chunkStartMs,
      endMs: chunkStartMs + list.length * perWordMs,
      words: list,
    });
  }
  return chunks;
}

/** Fractional keys for `count` segments, in order — what the segmenter would mint. */
export function seqKeys(count: number): string[] {
  const keys: string[] = [];
  let previous: string | undefined;
  for (let i = 0; i < count; i += 1) {
    previous = seqBetween(previous);
    keys.push(previous);
  }
  return keys;
}

export async function createEdgTestContext(): Promise<EdgTestContext | null> {
  if (!isRedisAvailable()) {
    edgSkipReason = redisSkipReason;
    return null;
  }

  let database: TestDatabase | null = null;
  let redisUrl: string;

  try {
    database = await createTestDatabase();
    if (database === null) {
      edgSkipReason = "no test database";
      return null;
    }
    redisUrl = testRedisUrl();
  } catch (error) {
    edgSkipReason = error instanceof Error ? error.message : String(error);
    if (database !== null) await database.stop();
    return null;
  }

  const keys = generateJwtKeys();
  process.env["DATABASE_URL"] = database.url;
  process.env["REDIS_URL"] = redisUrl;
  process.env["JWT_PRIVATE_KEY"] = keys.privateKey;
  process.env["JWT_PUBLIC_KEY"] = keys.publicKey;
  resetEnvCache();

  // The realtime bus is the one substitution.
  //
  // `RedisRealtimeBus` duplicates the shared `RedisService` client, which is
  // created `lazyConnect: true, enableOfflineQueue: false`; the duplicate
  // inherits both, so its very first `SUBSCRIBE` is rejected with "Stream isn't
  // writeable" before ioredis has finished dialling. That is A08's file and A08's
  // call to make (reported with this work package), so the suite proves the
  // publisher-to-socket path over the in-memory broker — which is the same
  // `RealtimeBus` interface and the same gateway — rather than papering over it.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REALTIME_BUS)
    .useValue(new InMemoryRealtimeBus(new InMemoryRealtimeBroker()))
    .compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();
  // The realtime gateway attaches to the adapter's HTTP server on bootstrap, so
  // the WebSocket assertions need a listening socket rather than `init()` alone.
  await app.listen(0);

  const address = app.getHttpServer().address() as { port: number };
  const prisma = new PrismaClient({ datasources: { db: { url: database.url } } });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const tokens = app.get(TokenService);
  const edg = app.get(EdgService);

  const workspaceId = newId();
  const otherWorkspaceId = newId();
  const userId = newId();
  const db = database;

  async function seedTenant(): Promise<void> {
    await prisma.user.create({
      data: { id: userId, email: `edg-${userId.toLowerCase()}@example.test`, name: "EDG tester" },
    });
    for (const id of [workspaceId, otherWorkspaceId]) {
      await prisma.workspace.create({
        data: {
          id,
          slug: `ws-${id.toLowerCase()}`,
          name: `ws-${id.slice(-4)}`,
          ownerId: userId,
          billingCountry: "IN",
        },
      });
      await prisma.membership.create({
        data: { id: newId(), workspaceId: id, userId, role: "owner", status: "active" },
      });
    }
  }

  await seedTenant();

  return {
    app,
    prisma,
    redis,
    port: address.port,
    workspaceId,
    otherWorkspaceId,
    userId,

    token(role = "editor", ws = workspaceId) {
      return tokens.mintAccessToken({ userId, workspaceId: ws, role, kind: "web" }).accessToken;
    },

    async seed(options = {}) {
      const words = options.words ?? 120;
      const chunkSize = options.chunkSize ?? 60;
      const projectId = newId();
      const transcriptId = newId();
      const mediaId = newId();
      const chunks = buildTranscript(words, chunkSize);

      await prisma.project.create({
        data: {
          id: projectId,
          workspaceId: options.workspaceId ?? workspaceId,
          title: "EDG suite",
          aspect: "r9x16",
          sourceLanguage: "hi-Latn",
          scripts: ["roman"],
          createdBy: userId,
        },
      });
      await prisma.mediaAsset.create({
        data: {
          id: mediaId,
          projectId,
          role: "primary",
          storageKey: `ws/${workspaceId}/p/${projectId}/media/${mediaId}/raw.mp4`,
          durationMs: chunks.at(-1)?.endMs ?? 0,
          fps: 30,
          width: 1080,
          height: 1920,
          status: "ready",
        },
      });
      await prisma.transcript.create({
        data: { id: transcriptId, projectId, language: "hi-Latn", currentRevision: 1 },
      });
      await prisma.transcriptChunk.createMany({
        data: chunks.map((chunk) => ({
          id: newId(),
          transcriptId,
          revision: 1,
          chunkIdx: chunk.chunkIdx,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          words: chunk.words as never,
          nextWordSeq: chunk.words.length,
        })),
      });

      const created = await edg.initialise(projectId, {
        transcriptId,
        language: "hi-Latn",
        scripts: ["roman"],
        speakers: [{ id: "s1" }, { id: "s2" }],
        chunks,
        author: userId,
        source: "worker",
      });

      const segments = await prisma.edgSegment.findMany({
        where: { edgId: created.edgId, deletedAtRev: null },
        orderBy: { seq: "asc" },
      });

      return {
        projectId,
        edgId: created.edgId,
        transcriptId,
        mediaId,
        revision: created.revision,
        segments: segments as unknown as Segment[],
        chunks,
      };
    },

    async resetBudget(ws = workspaceId) {
      await redis.del(`${RATE_LIMIT_PREFIX}:${EDG_OPS_BUCKET.name}:${ws}`);
    },

    async reset() {
      await prisma.$executeRawUnsafe(
        "TRUNCATE TABLE edg_snapshots, edg_revisions, edg_pass_items, edg_passes, edg_segments, edg_documents, transcript_chunks, transcripts, media_assets, projects CASCADE",
      );
      const rateKeys = await redis.keys(`${RATE_LIMIT_PREFIX}:${EDG_OPS_BUCKET.name}:*`);
      if (rateKeys.length > 0) await redis.del(...rateKeys);
    },

    async stop() {
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
      await db.stop();
    },
  };
}
