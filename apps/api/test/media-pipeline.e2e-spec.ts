/**
 * The media pipeline end to end, with the real worker.
 *
 * ```
 * POST /projects → media/init → a genuine multipart PUT to MinIO
 *   → POST /media/{id}/complete            (enqueues media.probe, and only that)
 *   → apps/worker-media, spawned as a process, against the shared Redis
 *   → PATCH /internal/media/{id}           signed, allow-listed
 *   → POST /internal/jobs/{id}/complete    signed
 *   → the probe's completion handler enqueues media.proxy as a CHILD
 *   → the worker builds every CONTRACTS §6 derived object
 * ```
 *
 * **The worker is not imported, it is spawned** — `node apps/worker-media/dist/index.js`,
 * exactly what a container runs. Importing its processors would test the functions
 * and skip everything that actually breaks in production: the boot check, the
 * BullMQ prefix, the envelope on the wire, the signature over the raw bytes, and
 * the queue policy the `Worker` constructor reads. Spawning it costs a few seconds
 * and covers all five.
 *
 * The Nest app listens on a real port for the same reason: the worker signs and
 * posts over HTTP, and a supertest agent has no address a child process can reach.
 *
 * It needs Postgres, Redis, an S3-compatible store and ffmpeg; without any of them
 * it skips loudly rather than failing.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import {
  VIDEO_DURATION_S,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  buildFixtures,
  isFfmpegAvailable,
  type FixtureSet,
} from "./media-fixtures.js";
import { isStorageAvailable, storageSkipReason } from "./minio-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { DERIVED_STORE, RAW_STORE, S3ObjectStore } from "../src/common/storage/index.js";
import { ENV } from "../src/config/config.module.js";

import type { TestDatabase } from "./db-harness.js";
import type { ObjectStore } from "../src/common/storage/index.js";
import type { INestApplication } from "@nestjs/common";

const REPO_ROOT = resolve(__dirname, "../../..");
const WORKER_DIR = resolve(REPO_ROOT, "apps/worker-media");
const WORKER_ENTRY = resolve(WORKER_DIR, "dist/index.js");

const PREFIX = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";
const CALLBACK_SECRET = "media-pipeline-secret-at-least-32-characters";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const STORAGE_READY = isStorageAvailable();
const FFMPEG_READY = isFfmpegAvailable();
const CAN_RUN = DB_READY && REDIS_READY && STORAGE_READY && FFMPEG_READY;

if (!CAN_RUN) {
  console.warn(
    `[media-pipeline.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}` +
      `${REDIS_READY ? "" : `redis: ${redisSkipReason}. `}` +
      `${STORAGE_READY ? "" : `storage: ${storageSkipReason}. `}` +
      `${FFMPEG_READY ? "" : "ffmpeg is not on PATH."}`,
  );
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Crockford base32 fixture ids, distinct per run — they end up inside keys. */
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
const id = (kind: string): string => `01JD${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const USER = id("US3R");
const WORKSPACE = id("WKSP");

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let rawStore: ObjectStore;
let derivedStore: ObjectStore;
let worker: ChildProcess | null = null;
let fixtures: FixtureSet | null = null;
let apiOrigin = "";

const rawKeysWritten: string[] = [];
const derivedKeysWritten: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A port nothing is listening on, chosen before the app boots. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function accessToken(): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: USER,
    ws: WORKSPACE,
    role: "owner",
    kind: "web",
    jti: id("JT1"),
    iat: now,
    exp: now + 3_600,
    // A04 pins the issuer to `API_ORIGIN`, which is the port the app is on.
    iss: apiOrigin,
  };
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

function api() {
  const token = accessToken();
  const agent = request(app.getHttpServer());
  return {
    get: (path: string) => agent.get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string) => agent.post(path).set("Authorization", `Bearer ${token}`),
  };
}

interface UploadTicketBody {
  mediaId: string;
  uploadId: string | null;
  key: string;
  partSizeBytes: number;
  parts: { partNumber: number; url: string }[];
}

/** Push a local file through A06's presigned flow and return the media id. */
async function upload(
  projectId: string,
  file: string,
  filename: string,
  mime: string,
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(file);

  const init = await api()
    .post(`/projects/${projectId}/media/init`)
    .send({ filename, size: body.byteLength, mime })
    .expect(201);
  const ticket = init.body as UploadTicketBody;
  rawKeysWritten.push(ticket.key);

  const etags: string[] = [];
  for (const part of ticket.parts) {
    const start = (part.partNumber - 1) * ticket.partSizeBytes;
    const chunk = body.subarray(start, start + ticket.partSizeBytes);
    const response = await fetch(part.url, { method: "PUT", body: chunk });
    if (!response.ok)
      throw new Error(`part ${String(part.partNumber)}: ${String(response.status)}`);
    etags.push(response.headers.get("etag") ?? "");
  }

  const completed = await api()
    .post(`/media/${ticket.mediaId}/complete`)
    .send({ etags })
    .expect(201);
  // A07: one job, and it is the probe. The proxy is a child of its completion.
  expect(completed.body.proxyJobId).toBeNull();

  return ticket.mediaId;
}

/** Poll the row until it settles, so the test waits for work rather than a clock. */
async function waitForStatus(
  mediaId: string,
  wanted: readonly string[],
  timeoutMs = 150_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    if (wanted.includes(media.status)) return media as unknown as Record<string, unknown>;
    if (Date.now() > deadline) {
      const jobs = await prisma.job.findMany({
        where: { projectId: media.projectId },
        select: { type: true, status: true, error: true },
      });
      throw new Error(
        `media ${mediaId} was still "${media.status}" after ${String(timeoutMs)} ms; jobs: ` +
          JSON.stringify(jobs),
      );
    }
    await new Promise((done) => setTimeout(done, 750));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!CAN_RUN) return;

  fixtures = await buildFixtures();

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();

  await prisma.user.create({
    data: { id: USER, email: `a07+${RUN}@example.test`, name: "A07 pipeline" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `a07-${RUN}`,
      name: `a07-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });
  await prisma.plan.upsert({
    where: { key: "free" },
    update: {},
    create: {
      id: id("PLNF"),
      key: "free",
      name: "Free",
      creditsPerMonthTenths: 300,
      entitlements: {
        maxFileBytes: 500 * 1024 * 1024,
        maxDurationMs: 20 * 60 * 1000,
        retentionDays: 7,
      },
    },
  });

  redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

  const port = await freePort();
  apiOrigin = `http://127.0.0.1:${String(port)}`;

  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
  const { setupOpenApi } = await import("../src/openapi.js");
  const { resolveEnv } = await import("../src/config/config.module.js");

  const env = {
    ...resolveEnv(),
    JWT_PUBLIC_KEY: PEM_PUBLIC,
    API_ORIGIN: apiOrigin,
    INTERNAL_CALLBACK_SECRET: CALLBACK_SECRET,
  } as Env;

  rawStore = new S3ObjectStore({
    kind: "s3",
    bucket: env.S3_BUCKET_RAW,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
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
  await app.listen(port, "127.0.0.1");

  // The worker runs the built output, which is what a container runs.
  const build = spawnSync("pnpm", ["--filter", "@montaj/worker-media", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    shell: true,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (build.status !== 0) {
    throw new Error(`worker build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`);
  }

  worker = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      REDIS_URL: testRedisUrl(),
      MONTAJ_QUEUE_PREFIX: PREFIX,
      API_ORIGIN: apiOrigin,
      INTERNAL_CALLBACK_SECRET: CALLBACK_SECRET,
      S3_ENDPOINT: env.S3_ENDPOINT,
      S3_REGION: env.S3_REGION,
      S3_BUCKET_RAW: env.S3_BUCKET_RAW,
      S3_ACCESS_KEY: env.S3_ACCESS_KEY,
      S3_SECRET_KEY: env.S3_SECRET_KEY,
      R2_ENDPOINT: env.R2_ENDPOINT,
      R2_BUCKET_DERIVED: env.R2_BUCKET_DERIVED,
      R2_ACCESS_KEY: env.R2_ACCESS_KEY,
      R2_SECRET_KEY: env.R2_SECRET_KEY,
      WORKER_MEDIA_CONCURRENCY: "2",
      // Probe and proxy only. This suite is about what ffmpeg does to an upload;
      // the default queue list also includes `media.acquire`, and a worker that
      // consumes that one refuses to start until the downloader's digest is
      // pinned (REP-010). Naming the queues is what the boot check is for — a
      // pod that will never acquire anything is not asked for a binary it does
      // not need — and it also keeps yt-dlp off the dependency list of a suite
      // that has no business needing it.
      WORKER_MEDIA_QUEUES: "media.probe,media.proxy",
    },
  });
  worker.stdout?.setEncoding("utf8");
  worker.stderr?.setEncoding("utf8");
  const workerLog: string[] = [];
  worker.stdout?.on("data", (chunk: string) => workerLog.push(chunk));
  worker.stderr?.on("data", (chunk: string) => workerLog.push(chunk));

  // Wait for both queues to report ready, so the first job is not raced.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const log = workerLog.join("");
    const ready = (log.match(/waiting for jobs on/g) ?? []).length;
    if (ready >= 2) break;
    if (worker.exitCode !== null || Date.now() > deadline) {
      throw new Error(`worker-media did not become ready:\n${log}`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}, 600_000);

afterAll(async () => {
  if (!CAN_RUN) return;

  worker?.kill("SIGTERM");
  await new Promise((done) => setTimeout(done, 1_500));
  if (worker !== null && worker.exitCode === null) worker.kill("SIGKILL");

  if (prisma !== undefined) {
    const projects = await prisma.project.findMany({
      where: { workspaceId: WORKSPACE },
      select: { id: true },
    });
    const projectIds = projects.map((project) => project.id);
    await prisma.jobEvent.deleteMany({
      where: { job: { workspaceId: WORKSPACE } },
    });
    await prisma.job.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.mediaAsset.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.membership.deleteMany({ where: { userId: USER } });
    await prisma.workspace.deleteMany({ where: { id: WORKSPACE } });
    await prisma.user.deleteMany({ where: { id: USER } });
  }

  // The buckets are shared with every other agent, so this run removes only its
  // own prefixes rather than emptying anything.
  if (rawKeysWritten.length > 0) await rawStore.deleteMany(rawKeysWritten).catch(() => 0);
  if (derivedKeysWritten.length > 0)
    await derivedStore.deleteMany(derivedKeysWritten).catch(() => 0);

  await app?.close();
  redis?.disconnect();
  await db?.stop();
  await fixtures?.cleanup();
}, 120_000);

async function newProject(title: string): Promise<string> {
  const response = await api().post("/projects").send({ title }).expect(201);
  return response.body.id as string;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!CAN_RUN)("media pipeline (A07)", () => {
  it("takes a 10 s clip from upload to every CONTRACTS §6 derived object", async () => {
    const projectId = await newProject("A07 pipeline");
    const mediaId = await upload(projectId, fixtures?.video ?? "", "clip.mp4", "video/mp4");

    const media = await waitForStatus(mediaId, ["ready", "failed"]);
    expect(media["status"]).toBe("ready");

    // --- the probe's measurements, through the allow-listed patch -----------
    expect(media["durationMs"]).toBeGreaterThanOrEqual((VIDEO_DURATION_S - 1) * 1000);
    expect(media["durationMs"]).toBeLessThanOrEqual((VIDEO_DURATION_S + 1) * 1000);
    expect(media["width"]).toBe(VIDEO_WIDTH);
    expect(media["height"]).toBe(VIDEO_HEIGHT);
    expect(Math.round(Number(media["fps"]))).toBe(VIDEO_FPS);
    expect(media["codec"]).toBe("h264");
    expect(media["hasAudio"]).toBe(true);
    expect(media["hdr"]).toBe(false);
    expect(media["audioChannels"]).toBeGreaterThanOrEqual(1);
    expect(media["failureReason"]).toBeNull();

    // --- the derived keys, exactly CONTRACTS §6 ----------------------------
    const prefix = `ws/${WORKSPACE}/p/${projectId}/media/${mediaId}`;
    expect(media["proxyKey"]).toBe(`${prefix}/proxy540.mp4`);
    expect(media["audio16kKey"]).toBe(`${prefix}/audio16k.wav`);
    expect(media["audio48kKey"]).toBe(`${prefix}/audio48k.wav`);
    expect(media["waveformKey"]).toBe(`${prefix}/waveform.json`);
    const thumbs = media["thumbKeys"] as string[];
    expect(thumbs.length).toBeGreaterThanOrEqual(9);
    expect(thumbs[0]).toBe(`${prefix}/thumb-0.jpg`);

    // --- every object is really in the derived bucket -----------------------
    const expected = [
      `${prefix}/proxy540.mp4`,
      `${prefix}/audio16k.wav`,
      `${prefix}/audio48k.wav`,
      `${prefix}/waveform.json`,
      ...thumbs,
    ];
    derivedKeysWritten.push(...expected);
    for (const key of expected) {
      const head = await derivedStore.head(key);
      expect(head, `missing ${key}`).not.toBeNull();
      expect(head?.sizeBytes, key).toBeGreaterThan(0);
    }

    // --- the artefacts are what they claim to be ----------------------------
    const waveform = JSON.parse(
      (await derivedStore.get(`${prefix}/waveform.json`)).toString("utf8"),
    ) as { peakRate: number; peaks: number[]; rms: { rate: number; values: number[] } };
    expect(waveform.peakRate).toBe(100);
    // 100 peaks a second over ten seconds, give or take the final partial window.
    expect(waveform.peaks.length).toBeGreaterThan(900);
    expect(waveform.rms.rate).toBe(10);
    expect(Math.max(...waveform.peaks)).toBeGreaterThan(0.1);
    expect(Math.max(...waveform.peaks)).toBeLessThanOrEqual(1);

    // 16 kHz mono s16 for ten seconds is ~320 KB; 48 kHz is three times that.
    const asr = await derivedStore.head(`${prefix}/audio16k.wav`);
    const master = await derivedStore.head(`${prefix}/audio48k.wav`);
    expect(asr?.sizeBytes).toBeGreaterThan(16_000 * 2 * (VIDEO_DURATION_S - 1));
    expect(master?.sizeBytes).toBeGreaterThan((asr?.sizeBytes ?? 0) * 2);

    // --- the proxy ran as a CHILD of the probe -----------------------------
    const probeJob = await prisma.job.findFirstOrThrow({
      where: { projectId, type: "media.probe" },
    });
    const proxyJob = await prisma.job.findFirstOrThrow({
      where: { projectId, type: "media.proxy" },
    });
    expect(probeJob.status).toBe("succeeded");
    expect(proxyJob.status).toBe("succeeded");
    expect(proxyJob.jobKey).toBe(`media.proxy:${mediaId}`);
    // The child was enqueued off the probe's completion, not by the API's upload
    // path — the event is recorded against the parent.
    // `JobEventsService` files the lifecycle point under `data.event`.
    const events = await prisma.jobEvent.findMany({ where: { jobId: probeJob.id } });
    const named = events.map((event) => ({
      name: (event.data as Record<string, unknown> | null)?.["event"],
      data: event.data as Record<string, unknown>,
    }));
    const child = named.find((event) => event.name === "job.child_enqueued");
    expect(child, "the probe should have enqueued its proxy").toBeDefined();
    expect(child?.data["childJobId"]).toBe(proxyJob.id);
    // Progress was reported, which is also the heartbeat.
    expect(named.some((event) => event.name === "job.progress")).toBe(true);

    // --- loudness and silence rode along in the probe result ---------------
    const result = probeJob.result as Record<string, unknown>;
    expect(result["hasAudio"]).toBe(true);
    const audio = result["audio"] as Record<string, unknown>;
    expect(typeof audio["loudnessLufs"]).toBe("number");
    expect(audio["silenceRatio"]).not.toBeNull();

    // --- the signed URLs A06 hands the studio now resolve ------------------
    const urls = await api().get(`/projects/${projectId}/media/${mediaId}/urls`).expect(200);
    expect(urls.body.proxy).toBeDefined();
    expect(urls.body.audio16k).toBeDefined();
    expect(urls.body.thumbs.length).toBeGreaterThanOrEqual(9);
  }, 300_000);

  it("gives an audio-only upload two WAVs and a waveform, and no proxy", async () => {
    const projectId = await newProject("A07 podcast");
    const mediaId = await upload(projectId, fixtures?.audio ?? "", "podcast.mp3", "audio/mpeg");

    const media = await waitForStatus(mediaId, ["ready", "failed"]);
    expect(media["status"]).toBe("ready");

    const prefix = `ws/${WORKSPACE}/p/${projectId}/media/${mediaId}`;
    expect(media["audio16kKey"]).toBe(`${prefix}/audio16k.wav`);
    expect(media["audio48kKey"]).toBe(`${prefix}/audio48k.wav`);
    expect(media["waveformKey"]).toBe(`${prefix}/waveform.json`);
    // No video half at all: CONTRACTS §6 has no poster key, so `thumb-0.jpg` is
    // the poster where one exists, and there is none here.
    expect(media["proxyKey"]).toBeNull();
    expect(media["thumbKeys"]).toEqual([]);
    expect(media["hasAudio"]).toBe(true);
    expect(media["width"]).toBeNull();
    expect(media["codec"]).toBe("mp3");

    derivedKeysWritten.push(
      `${prefix}/audio16k.wav`,
      `${prefix}/audio48k.wav`,
      `${prefix}/waveform.json`,
    );
    expect(await derivedStore.head(`${prefix}/proxy540.mp4`)).toBeNull();
    expect(await derivedStore.head(`${prefix}/audio16k.wav`)).not.toBeNull();
  }, 300_000);

  it("flags a PQ source as HDR and tone-maps its proxy without error", async () => {
    const projectId = await newProject("A07 HDR");
    const mediaId = await upload(projectId, fixtures?.hdr ?? "", "hdr.mp4", "video/mp4");

    const media = await waitForStatus(mediaId, ["ready", "failed"]);
    expect(media["status"]).toBe("ready");
    expect(media["hdr"]).toBe(true);

    const prefix = `ws/${WORKSPACE}/p/${projectId}/media/${mediaId}`;
    derivedKeysWritten.push(
      `${prefix}/proxy540.mp4`,
      `${prefix}/audio16k.wav`,
      `${prefix}/audio48k.wav`,
      `${prefix}/waveform.json`,
      ...(media["thumbKeys"] as string[]),
    );
    // The proxy exists and is a real MP4 with content in it.
    const proxy = await derivedStore.head(`${prefix}/proxy540.mp4`);
    expect(proxy?.sizeBytes).toBeGreaterThan(1_000);
    // 640×360 is already under 540 on its short side, so it is not upscaled.
    expect(media["width"]).toBe(640);
    // A silent source: no audio artefacts, and the pipeline still finishes.
    expect(media["hasAudio"]).toBe(false);
    expect(media["audio16kKey"]).toBeNull();
  }, 300_000);

  it("fails a corrupt upload with a user-facing reason and builds nothing", async () => {
    const projectId = await newProject("A07 corrupt");
    const mediaId = await upload(projectId, fixtures?.corrupt ?? "", "broken.mp4", "video/mp4");

    const media = await waitForStatus(mediaId, ["failed", "ready"]);
    expect(media["status"]).toBe("failed");
    // A closed-set code the studio can translate, not an ffmpeg sentence.
    expect(String(media["failureReason"]).startsWith("media/")).toBe(true);
    expect(media["proxyKey"]).toBeNull();
    expect(media["audio16kKey"]).toBeNull();

    const probeJob = await prisma.job.findFirstOrThrow({
      where: { projectId, type: "media.probe" },
    });
    expect(probeJob.status).toBe("failed");
    // Not retryable, so it went straight to the dead-letter path rather than
    // burning three attempts on bytes that will never decode.
    expect((probeJob.error as Record<string, unknown>)["retryable"]).toBe(false);
    // The redacted ffmpeg tail is on the error for an operator; no signed URL.
    expect(JSON.stringify(probeJob.error)).not.toContain("X-Amz-Signature=");

    // No proxy was enqueued for a file that cannot be read.
    expect(await prisma.job.count({ where: { projectId, type: "media.proxy" } })).toBe(0);
  }, 300_000);
});
