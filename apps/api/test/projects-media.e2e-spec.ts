/**
 * The whole ingest path, against real infrastructure.
 *
 * `POST /projects` → `media/init` → **a genuine multipart PUT of every part to
 * MinIO through the presigned URLs** → `complete` → the `media.probe` envelope on
 * the real BullMQ queue → signed derived URLs → replace → import → the retention
 * sweep.
 *
 * The upload is not faked, and that is the point of the suite. A presigned URL is
 * a signature over a canonical request, and every way of getting it wrong —
 * a checksum header the browser cannot send, virtual-host addressing MinIO does
 * not answer to, a part number outside the signature — produces a URL that looks
 * perfectly fine in a unit test and returns `SignatureDoesNotMatch` to a browser.
 * The only test that catches those is one that actually PUTs the bytes.
 *
 * It needs Postgres, Redis and an S3-compatible store; without any of them it
 * skips loudly rather than failing.
 */
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";

import { type Job, type PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isStorageAvailable, storageSkipReason } from "./minio-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { DERIVED_STORE, RAW_STORE, S3ObjectStore } from "../src/common/storage/index.js";
import { ENV } from "../src/config/config.module.js";
import { bullJobId } from "../src/jobs/queue.registry.js";
import { RetentionService } from "../src/media/retention.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { ObjectStore } from "../src/common/storage/index.js";
import type { INestApplication } from "@nestjs/common";

const PREFIX = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const STORAGE_READY = isStorageAvailable();
const CAN_RUN = DB_READY && REDIS_READY && STORAGE_READY;

if (!CAN_RUN) {
  console.warn(
    `[projects-media.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}` +
      `${REDIS_READY ? "" : `redis: ${redisSkipReason}. `}` +
      `${STORAGE_READY ? "" : `storage: ${storageSkipReason}.`}`,
  );
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

/**
 * Fixture ids, distinct per run and valid ULIDs — they end up inside object keys,
 * which `storage.keys.ts` refuses to build from anything else. Crockford base32
 * excludes I, L, O and U, hence the spelling of the tags.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function crockford(value: number, length: number): string {
  let out = "";
  let remaining = value;
  while (remaining > 0) {
    out = `${CROCKFORD[remaining % 32] ?? "0"}${out}`;
    remaining = Math.floor(remaining / 32);
  }
  return out.padStart(length, "0").slice(-length);
}
const RUN = crockford(Date.now(), 10);
const id = (kind: string): string => `01JC${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const USER = id("US3R");
const WORKSPACE = id("WKSP");
const OTHER_WORKSPACE = id("WKSX");

/**
 * Five MiB parts rather than the shipped sixteen.
 *
 * The part size is tuning, not a contract (`object-store.ts`), and five MiB is
 * the smallest a multipart upload is allowed to use — so the suite can prove the
 * multi-part path with a six MiB file instead of a seventeen MiB one. Everything
 * else about the store is the shipped configuration.
 */
const TEST_PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_SIZE = TEST_PART_SIZE + 1024 * 1024;

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let rawStore: ObjectStore;
let derivedStore: ObjectStore;
/** Every key this run wrote, deleted in `afterAll`. */
const rawKeysWritten: string[] = [];
const derivedKeysWritten: string[] = [];

function accessToken(workspaceId = WORKSPACE, role = "owner"): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: USER,
    ws: workspaceId,
    role,
    kind: "web",
    jti: id("JT1"),
    iat: now,
    exp: now + 900,
    // A04 pins the issuer to `API_ORIGIN` and refuses anything else, so a token
    // minted for this suite has to name it too.
    iss: process.env["API_ORIGIN"] ?? "http://localhost:3001",
  };
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

function api(token = accessToken()) {
  const agent = request(app.getHttpServer());
  return {
    get: (path: string) => agent.get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string) => agent.post(path).set("Authorization", `Bearer ${token}`),
    patch: (path: string) => agent.patch(path).set("Authorization", `Bearer ${token}`),
    delete: (path: string) => agent.delete(path).set("Authorization", `Bearer ${token}`),
  };
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `a06+${RUN}@example.test`, name: "A06 test" },
  });
  for (const [workspaceId, slug, membershipId] of [
    [WORKSPACE, `a06-${RUN}`, id("MBR1")],
    [OTHER_WORKSPACE, `a06-other-${RUN}`, id("MBR2")],
  ] as const) {
    await prisma.workspace.create({
      data: { id: workspaceId, slug, name: slug, ownerId: USER, billingCountry: "IN" },
    });
    await prisma.membership.create({
      data: { id: membershipId, workspaceId, userId: USER, role: "owner", status: "active" },
    });
  }

  // Both plans this suite touches carry the same caps, so which one a case
  // resolves through cannot change the answer. 500 MB is what the
  // `media/too_large` case asserts on.
  // The entitlement stub reads the FREE plan's row for every workspace, so the
  // suite seeds it rather than depending on `db:seed` having been run: a suite
  // that only works on somebody's already-seeded database is a suite that fails
  // in CI.
  await prisma.plan.upsert({
    where: { key: "free" },
    update: { entitlements: SUITE_PLAN_CAPS },
    create: {
      id: id("PLNF"),
      key: "free",
      name: "Free",
      creditsPerMonthTenths: 300,
      entitlements: SUITE_PLAN_CAPS,
    },
  });

  // A creator subscription gives admission control the headroom the suite needs:
  // it uploads many files without retiring their jobs between cases. Since A07
  // one upload enqueues one job rather than two, so the Free lane of two is no
  // longer the binding constraint it was.
  //
  // `entitlements` is stated here rather than left empty. This fixture used to
  // create the creator plan bare and rely on the caps falling back to the Free
  // row — which worked only because nothing had seeded the real plans. The test
  // database template now carries them (`test/global-setup.ts`), exactly as a
  // deployed database does, and the real creator plan allows 4 GB. A fixture
  // that depends on a row being ABSENT is a fixture that breaks the moment the
  // row is correctly present; this one says what cap it wants and asserts
  // against that.
  const plan = await prisma.plan.upsert({
    where: { key: "creator" },
    update: { entitlements: SUITE_PLAN_CAPS },
    create: {
      id: id("PLAN"),
      key: "creator",
      name: "Creator",
      creditsPerMonthTenths: 3_000,
      entitlements: SUITE_PLAN_CAPS,
    },
  });
  await prisma.subscription.create({
    data: {
      id: id("SUBS"),
      workspaceId: WORKSPACE,
      planId: plan.id,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
}

/** Plan caps this suite asserts against, on every plan it seeds. */
const SUITE_PLAN_CAPS = {
  maxFileBytes: 500 * 1024 * 1024,
  maxDurationMs: 20 * 60 * 1000,
  retentionDays: 7,
} as const;

async function cleanup(): Promise<void> {
  if (prisma === undefined) return;
  const workspaces = [WORKSPACE, OTHER_WORKSPACE];
  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaces } },
    select: { id: true },
  });
  const projectIds = projects.map((project) => project.id);

  await prisma.job.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.subscription.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.mediaAsset.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.folder.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await prisma.user.deleteMany({ where: { id: USER } });

  // The buckets are shared with every other agent, so this run cleans up its own
  // prefixes rather than emptying anything.
  if (rawKeysWritten.length > 0) await rawStore.deleteMany(rawKeysWritten).catch(() => 0);
  if (derivedKeysWritten.length > 0)
    await derivedStore.deleteMany(derivedKeysWritten).catch(() => 0);

  if (redis === undefined) return;
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

/** Create a project and return its id. */
async function newProject(title: string): Promise<string> {
  const response = await api().post("/projects").send({ title }).expect(201);
  return response.body.id as string;
}

interface UploadTicketBody {
  mediaId: string;
  uploadId: string | null;
  key: string;
  partSizeBytes: number;
  parts: { partNumber: number; url: string }[];
  duplicate: boolean;
}

/** PUT every part to the store exactly as a browser would, and return the ETags. */
async function uploadParts(ticket: UploadTicketBody, body: Buffer): Promise<string[]> {
  const etags: string[] = [];
  for (const part of ticket.parts) {
    const start = (part.partNumber - 1) * ticket.partSizeBytes;
    const chunk = body.subarray(start, start + ticket.partSizeBytes);
    const response = await fetch(part.url, { method: "PUT", body: chunk });
    if (!response.ok) {
      throw new Error(`part ${String(part.partNumber)} failed: ${String(response.status)}`);
    }
    const etag = response.headers.get("etag");
    if (etag === null) throw new Error(`part ${String(part.partNumber)} returned no ETag`);
    etags.push(etag);
  }
  return etags;
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();
  await seed();

  redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

  // Imported lazily so a skipped run never loads the Nest graph.
  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
  const { setupOpenApi } = await import("../src/openapi.js");
  const { resolveEnv } = await import("../src/config/config.module.js");

  const env = { ...resolveEnv(), JWT_PUBLIC_KEY: PEM_PUBLIC } as Env;
  rawStore = new S3ObjectStore({
    kind: "s3",
    bucket: env.S3_BUCKET_RAW,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    partSizeBytes: TEST_PART_SIZE,
  });
  derivedStore = new S3ObjectStore({
    kind: "r2",
    bucket: env.R2_BUCKET_DERIVED,
    endpoint: env.R2_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.R2_ACCESS_KEY,
    secretAccessKey: env.R2_SECRET_KEY,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(
      Object.assign(prisma, {
        ping: async () => undefined,
        withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => prisma.$transaction(fn),
      }),
    )
    .overrideProvider(RedisService)
    .useValue({
      client: redis,
      ping: async () => undefined,
      onModuleDestroy: async () => undefined,
    })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(RAW_STORE)
    .useValue(rawStore)
    .overrideProvider(DERIVED_STORE)
    .useValue(derivedStore)
    .compile();

  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();
}, 180_000);

/**
 * Retire the jobs each test enqueued.
 *
 * Every upload enqueues one job and every import one, and a job in `queued`
 * occupies the workspace's concurrency lane (eight on the creator plan) until it
 * finishes. Without this the suite would 429 partway through — on the admission
 * control A08 built, working exactly as designed, rather than on anything A06
 * did wrong.
 */
afterEach(async () => {
  if (!CAN_RUN) return;
  await prisma.job.updateMany({
    where: { workspaceId: WORKSPACE, status: { in: ["queued", "running"] } },
    data: { status: "succeeded", finishedAt: new Date(), creditsChargedTenths: 0 },
  });
});

afterAll(async () => {
  if (!CAN_RUN) return;
  await cleanup();
  await app?.close();
  redis?.disconnect();
  await db?.stop();
});

describe.skipIf(!CAN_RUN)("projects", () => {
  it("creates, reads, filters and soft-deletes", async () => {
    const projectId = await newProject("Diwali reel");

    const folder = await api().post("/folders").send({ name: "Clients" }).expect(201);
    await api()
      .patch(`/projects/${projectId}`)
      .send({ folderId: folder.body.id, clientTag: "acme", status: "active" })
      .expect(200);

    const filtered = await api()
      .get(`/projects?q=diwali&status=active&folder=${String(folder.body.id)}&clientTag=acme`)
      .expect(200);
    expect(filtered.body.items.map((item: { id: string }) => item.id)).toContain(projectId);

    // `root` means "in no folder", so the project must no longer be listed there.
    const atRoot = await api().get("/projects?folder=root").expect(200);
    expect(atRoot.body.items.map((item: { id: string }) => item.id)).not.toContain(projectId);

    await api().delete(`/projects/${projectId}`).expect(200);
    await api().get(`/projects/${projectId}`).expect(404);
    // The row survives the delete; retention removes it, not the route (D47).
    const row = await prisma.project.findUnique({ where: { id: projectId } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it("creates a batch in one call", async () => {
    const response = await api()
      .post("/projects/batch")
      .send({ projects: [{ title: "one" }, { title: "two" }], clientTag: "batch" })
      .expect(201);
    expect(response.body.created).toHaveLength(2);
    expect(response.body.created[0].clientTag).toBe("batch");
  });

  it("refuses an empty folder delete only when it still holds something", async () => {
    const folder = await api().post("/folders").send({ name: "Holds work" }).expect(201);
    const projectId = await newProject("inside the folder");
    await api().patch(`/projects/${projectId}`).send({ folderId: folder.body.id }).expect(200);

    await api()
      .delete(`/folders/${String(folder.body.id)}`)
      .expect(409);
    await api().patch(`/projects/${projectId}`).send({ folderId: null }).expect(200);
    await api()
      .delete(`/folders/${String(folder.body.id)}`)
      .expect(200);
  });
});

describe.skipIf(!CAN_RUN)("media upload against a real object store", () => {
  it("signs parts, takes a genuine multipart PUT, completes and enqueues media.probe", async () => {
    const projectId = await newProject("Upload fixture");
    const body = randomBytes(UPLOAD_SIZE);

    // --- init -------------------------------------------------------------
    const init = await api()
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "holiday.mp4", size: body.byteLength, mime: "video/mp4" })
      .expect(201);
    const ticket = init.body as UploadTicketBody;
    rawKeysWritten.push(ticket.key);

    expect(ticket.duplicate).toBe(false);
    expect(ticket.uploadId).not.toBeNull();
    expect(ticket.parts).toHaveLength(2);
    // CONTRACTS §6, exactly.
    expect(ticket.key).toBe(`ws/${WORKSPACE}/p/${projectId}/media/${ticket.mediaId}/raw.mp4`);

    // --- the browser's half ----------------------------------------------
    const etags = await uploadParts(ticket, body);
    expect(etags).toHaveLength(2);

    // --- complete ---------------------------------------------------------
    const completed = await api()
      .post(`/media/${ticket.mediaId}/complete`)
      .send({ etags })
      .expect(201);

    expect(completed.body.media.status).toBe("uploaded");
    // The store's own byte count, not the client's claim.
    expect(completed.body.media.sizeBytes).toBe(body.byteLength);

    const head = await rawStore.head(ticket.key);
    expect(head?.sizeBytes).toBe(body.byteLength);

    // --- retention (D47) --------------------------------------------------
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: ticket.mediaId } });
    const uploadedAt = media.uploadedAt?.getTime() ?? 0;
    expect(Math.round(((media.rawPurgeAt?.getTime() ?? 0) - uploadedAt) / 86_400_000)).toBe(7);
    expect(media.derivedPurgeAt).not.toBeNull();
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.retentionUntil).not.toBeNull();
    // The first upload takes a draft project live.
    expect(project.status).toBe("active");

    // --- the queue, byte for byte (CONTRACTS §3) --------------------------
    const probeRow = await prisma.job.findUniqueOrThrow({
      where: { id: completed.body.probeJobId as string },
    });
    expect(probeRow.type).toBe("media.probe");
    expect(probeRow.status).toBe("queued");

    const envelope = await readEnvelope(probeRow);
    expect(Object.keys(envelope).sort()).toEqual([
      "attemptId",
      "createdAt",
      "jobId",
      "jobKey",
      "payload",
      "priority",
      "projectId",
      "workspaceId",
    ]);
    expect(envelope.jobId).toBe(probeRow.id);
    expect(envelope.attemptId).toBe(probeRow.attemptId);
    expect(envelope.workspaceId).toBe(WORKSPACE);
    expect(envelope.projectId).toBe(projectId);
    expect(envelope.jobKey).toBe(`media.probe:${ticket.mediaId}`);
    expect(typeof envelope.priority).toBe("number");
    expect(new Date(envelope.createdAt).toISOString()).toBe(envelope.createdAt);
    expect(envelope.payload).toMatchObject({
      mediaId: ticket.mediaId,
      projectId,
      bucket: "s3",
      key: ticket.key,
      derivedBucket: "r2",
    });

    // `media.proxy` is NOT enqueued here (A07): it is a child of the probe's
    // completion, so one upload takes one admission slot rather than two.
    expect(completed.body.proxyJobId).toBeNull();
    expect(await prisma.job.count({ where: { projectId, type: "media.proxy" } })).toBe(0);

    // --- idempotency ------------------------------------------------------
    const again = await api().post(`/media/${ticket.mediaId}/complete`).send({ etags }).expect(201);
    expect(again.body.probeJobId).toBe(completed.body.probeJobId);
    expect(await prisma.job.count({ where: { projectId, type: "media.probe" } })).toBe(1);
  }, 120_000);

  it("refuses a file over the plan cap with media/too_large", async () => {
    const projectId = await newProject("Too large");
    const response = await api()
      .post(`/projects/${projectId}/media/init`)
      // The entitlement stub is the Free plan: 500 MB.
      .send({ filename: "huge.mp4", size: 900 * 1024 * 1024, mime: "video/mp4" })
      .expect(413);
    expect(response.body.error.code).toBe("media/too_large");
    expect(await prisma.mediaAsset.count({ where: { projectId } })).toBe(0);
  });

  it("refuses a media type that is not on the allow-list (T7)", async () => {
    const projectId = await newProject("Bad type");
    const response = await api()
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "payload.exe", size: 10, mime: "application/x-msdownload" })
      .expect(415);
    expect(response.body.error.code).toBe("media/unsupported_type");
  });

  it("recognises a re-upload of the same bytes anywhere in the workspace", async () => {
    const firstProject = await newProject("Original");
    const body = randomBytes(1024);
    const contentHash = "sha256:a06-duplicate-fixture";

    const init = await api()
      .post(`/projects/${firstProject}/media/init`)
      .send({ filename: "clip.mp4", size: body.byteLength, mime: "video/mp4", contentHash })
      .expect(201);
    const ticket = init.body as UploadTicketBody;
    rawKeysWritten.push(ticket.key);
    await api()
      .post(`/media/${ticket.mediaId}/complete`)
      .send({ etags: await uploadParts(ticket, body) })
      .expect(201);

    // A different project, in the same workspace, with the same digest.
    const secondProject = await newProject("A second cut");
    const duplicate = await api()
      .post(`/projects/${secondProject}/media/init`)
      .send({ filename: "clip.mp4", size: body.byteLength, mime: "video/mp4", contentHash })
      .expect(201);

    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.mediaId).toBe(ticket.mediaId);
    expect(duplicate.body.parts).toEqual([]);
    expect(duplicate.body.uploadId).toBeNull();
  }, 60_000);

  it("replaces the bytes on the same row and flags a re-align", async () => {
    const projectId = await newProject("Replace me");
    const first = randomBytes(1024);

    const init = await api()
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "take-1.mp4", size: first.byteLength, mime: "video/mp4" })
      .expect(201);
    const ticket = init.body as UploadTicketBody;
    rawKeysWritten.push(ticket.key);
    await api()
      .post(`/media/${ticket.mediaId}/complete`)
      .send({ etags: await uploadParts(ticket, first) })
      .expect(201);

    // Pretend the probe has run, so the replace has stale derived keys to clear.
    await prisma.mediaAsset.update({
      where: { id: ticket.mediaId },
      data: { status: "ready", proxyKey: "ws/x/proxy540.mp4", durationMs: 12_000 },
    });

    const second = randomBytes(2048);
    const replaced = await api()
      .post(`/projects/${projectId}/media/${ticket.mediaId}/replace`)
      .send({ filename: "take-2.mov", size: second.byteLength, mime: "video/quicktime" })
      .expect(201);
    const replacement = replaced.body as UploadTicketBody;
    rawKeysWritten.push(replacement.key);

    expect(replacement.mediaId).toBe(ticket.mediaId);
    expect(replacement.key).toMatch(/raw\.mov$/);

    await api()
      .post(`/projects/${projectId}/media/${ticket.mediaId}/complete`)
      .send({ etags: await uploadParts(replacement, second) })
      .expect(201);

    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: ticket.mediaId } });
    expect(row.needsRealign).toBe(true);
    expect(row.proxyKey).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(Number(row.sizeBytes)).toBe(second.byteLength);
  }, 60_000);

  it("signs derived URLs that the store actually honours", async () => {
    const projectId = await newProject("Derived URLs");
    const init = await api()
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "clip.mp4", size: 1024, mime: "video/mp4" })
      .expect(201);
    const ticket = init.body as UploadTicketBody;
    rawKeysWritten.push(ticket.key);

    // Stand in for the proxy worker (A07): write one derived object and record it.
    const proxyKey = `ws/${WORKSPACE}/p/${projectId}/media/${ticket.mediaId}/proxy540.mp4`;
    const waveformKey = `ws/${WORKSPACE}/p/${projectId}/media/${ticket.mediaId}/waveform.json`;
    await derivedStore.put({ key: proxyKey, body: "not really a video", contentType: "video/mp4" });
    await derivedStore.put({ key: waveformKey, body: "[]", contentType: "application/json" });
    derivedKeysWritten.push(proxyKey, waveformKey);
    await prisma.mediaAsset.update({
      where: { id: ticket.mediaId },
      data: { proxyKey, waveformKey, status: "ready" },
    });

    const urls = await api().get(`/projects/${projectId}/media/${ticket.mediaId}/urls`).expect(200);

    expect(urls.body.audio16k).toBeUndefined();
    expect(urls.body.thumbs).toEqual([]);
    // Five minutes, and the URL works without any credentials of its own.
    const ttlMs = new Date(urls.body.expiresAt as string).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(4 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(5 * 60_000 + 5_000);

    const fetched = await fetch(urls.body.proxy as string);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("not really a video");
  }, 60_000);
});

describe.skipIf(!CAN_RUN)("subtitle import", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:03,500\nनमस्ते दोस्तों\n";

  it("stores a normalised cue list and enqueues ai.align", async () => {
    const projectId = await newProject("Import fixture");
    const response = await api()
      .post(`/projects/${projectId}/import`)
      .send({ kind: "srt", content: `\uFEFF${SRT.replace(/\n/g, "\r\n")}`, language: "hi" })
      .expect(201);

    expect(response.body.cueCount).toBe(1);
    expect(response.body.timed).toBe(true);
    derivedKeysWritten.push(response.body.key as string);

    const stored = JSON.parse(
      (await derivedStore.get(response.body.key as string)).toString("utf8"),
    ) as { cues: { text: string }[]; language: string };
    expect(stored.cues[0]?.text).toBe("नमस्ते दोस्तों");
    expect(stored.language).toBe("hi");

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: response.body.jobId as string },
    });
    expect(job.type).toBe("ai.align");

    // The sidecar is a media row, so retention and the project cascade cover it.
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: response.body.mediaId as string },
    });
    expect(asset.role).toBe("subtitle");
    expect(asset.bucket).toBe("r2");
    expect(asset.rawPurgeAt).toBeNull();
    expect(asset.derivedPurgeAt).not.toBeNull();
  });

  it("answers import/unparsable for a file that is not what it claims", async () => {
    const projectId = await newProject("Bad import");
    const response = await api()
      .post(`/projects/${projectId}/import`)
      .send({ kind: "vtt", content: "this is just prose" })
      .expect(422);
    expect(response.body.error.code).toBe("import/unparsable");
  });

  it("refuses a URL that resolves inside the network (T6)", async () => {
    const projectId = await newProject("SSRF");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/subs.srt",
      "http://[::1]/subs.srt",
      "file:///etc/passwd",
    ]) {
      const response = await api()
        .post(`/projects/${projectId}/import-url`)
        .send({ url, kind: "srt" })
        .expect(400);
      expect(response.body.error.code).toBe("import/blocked_url");
      // Nothing about the internal network reaches the caller.
      expect(JSON.stringify(response.body)).not.toContain("169.254");
    }
  });
});

describe.skipIf(!CAN_RUN)("ownership (THREAT-MODEL T5)", () => {
  it("hides another workspace's project behind a 404", async () => {
    const projectId = await newProject("Private");
    const stranger = accessToken(OTHER_WORKSPACE);

    await api(stranger).get(`/projects/${projectId}`).expect(404);
    await api(stranger).patch(`/projects/${projectId}`).send({ title: "mine now" }).expect(404);
    await api(stranger).delete(`/projects/${projectId}`).expect(404);
    await api(stranger)
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "x.mp4", size: 10, mime: "video/mp4" })
      .expect(404);
  });

  it("hides another workspace's media behind a 404", async () => {
    const projectId = await newProject("Private media");
    const init = await api()
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "clip.mp4", size: 1024, mime: "video/mp4" })
      .expect(201);
    const ticket = init.body as UploadTicketBody;
    rawKeysWritten.push(ticket.key);

    const stranger = accessToken(OTHER_WORKSPACE);
    await api(stranger).get(`/media/${ticket.mediaId}`).expect(404);
    await api(stranger)
      .post(`/media/${ticket.mediaId}/complete`)
      .send({ etags: ["x"] })
      .expect(404);
  });

  it("refuses a token with no live membership at all", async () => {
    const projectId = await newProject("Guarded");
    await prisma.membership.updateMany({
      where: { workspaceId: WORKSPACE, userId: USER },
      data: { status: "removed" },
    });
    try {
      const response = await api().get(`/projects/${projectId}`).expect(403);
      expect(response.body.error.code).toBe("auth/not_a_member");
    } finally {
      await prisma.membership.updateMany({
        where: { workspaceId: WORKSPACE, userId: USER },
        data: { status: "active" },
      });
    }
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app.getHttpServer()).get("/projects").expect(401);
  });
});

describe.skipIf(!CAN_RUN)("retention (D47)", () => {
  it("deletes raw objects past rawPurgeAt and leaves the derived ones", async () => {
    const projectId = await newProject("Purge me");
    const body = randomBytes(1024);

    const init = await api()
      .post(`/projects/${projectId}/media/init`)
      .send({ filename: "old.mp4", size: body.byteLength, mime: "video/mp4" })
      .expect(201);
    const ticket = init.body as UploadTicketBody;
    rawKeysWritten.push(ticket.key);
    await api()
      .post(`/media/${ticket.mediaId}/complete`)
      .send({ etags: await uploadParts(ticket, body) })
      .expect(201);

    const proxyKey = `ws/${WORKSPACE}/p/${projectId}/media/${ticket.mediaId}/proxy540.mp4`;
    await derivedStore.put({ key: proxyKey, body: "proxy bytes" });
    derivedKeysWritten.push(proxyKey);

    // Raw retention has passed; derived retention has not.
    await prisma.mediaAsset.update({
      where: { id: ticket.mediaId },
      data: {
        proxyKey,
        rawPurgeAt: new Date(Date.now() - 60_000),
        derivedPurgeAt: new Date(Date.now() + 86_400_000),
      },
    });

    const retention = app.get(RetentionService);
    const report = await retention.purgeDueMedia();

    expect(report.rawPurged).toBeGreaterThanOrEqual(1);
    expect(await rawStore.head(ticket.key)).toBeNull();
    // The proxy is untouched: the two clocks are independent.
    expect(await derivedStore.head(proxyKey)).not.toBeNull();

    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: ticket.mediaId } });
    expect(row.rawPurgedAt).not.toBeNull();
    expect(row.derivedPurgedAt).toBeNull();
    expect(row.proxyKey).toBe(proxyKey);

    // A second sweep finds nothing to do: the marker makes it idempotent.
    expect((await retention.purgeDueMedia()).rawPurged).toBe(0);
  }, 60_000);
});

interface Envelope {
  jobId: string;
  attemptId: string;
  workspaceId: string;
  projectId: string;
  priority: number;
  jobKey: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

/** The job's `data` as the worker will read it, straight out of Redis. */
async function readEnvelope(job: Job): Promise<Envelope> {
  const queue = new Queue(job.type, { connection: redis, prefix: PREFIX });
  try {
    const entry = await queue.getJob(bullJobId(job.id, job.attemptId ?? ""));
    if (entry === undefined) throw new Error(`no BullMQ job for ${job.id}`);
    return entry.data as Envelope;
  } finally {
    await queue.close();
  }
}
