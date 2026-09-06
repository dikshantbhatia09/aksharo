/**
 * The cloud render path end to end, with the real `apps/render` worker.
 *
 * ```
 * POST /projects/{id}/exports   mode:"cloud" → signed RenderManifest (caps, watermark)
 *   → render.video enqueued on BullMQ (the suite's own MONTAJ_QUEUE_PREFIX)
 * apps/render, spawned as a process against the shared Redis → verifies the
 *   manifest, downloads the source from MinIO, draws captions with Skia, encodes
 *   with ffmpeg, uploads the result to R2, signs POST /internal/jobs/{id}/complete
 * → RenderVideoCompletionHandler writes the exports row and a publish_events row
 * → credits settle at the cloud-render rate
 * GET  /exports/{id}/download → a signed URL that really resolves
 * ```
 *
 * **The worker is spawned, not imported** — `node apps/render/dist/index.js`,
 * exactly what a container runs (`media-pipeline.e2e-spec.ts` makes the same
 * choice for the same reason: importing the processor tests the function and
 * skips the boot check, the BullMQ prefix, the envelope on the wire and the real
 * signed callback).
 *
 * It needs Postgres, Redis, an S3-compatible store and ffmpeg; without any of
 * them it skips loudly rather than failing.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { creditCostTenths } from "@montaj/config";
import { verifyRenderManifest } from "@montaj/render-manifest";

import { AMPLE_TEST_CREDIT_TENTHS, fundWorkspaceCredits } from "./credits-fixture.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { createEdgTestContext, edgSkipReason, type EdgTestContext } from "./edg-harness.js";
import {
  buildFixtures,
  isFfmpegAvailable,
  VIDEO_DURATION_S,
  type FixtureSet,
} from "./media-fixtures.js";
import { isStorageAvailable, storageSkipReason } from "./minio-harness.js";
import { testRedisUrl } from "./redis-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";
import { S3ObjectStore } from "../src/common/storage/index.js";
import { resolveEnv } from "../src/config/config.module.js";
import { DEFAULT_STYLE_REF } from "../src/edg/init/transcript-init.js";

import type { ObjectStore } from "../src/common/storage/index.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const RENDER_DIR = resolve(REPO_ROOT, "apps/render");
const RENDER_ENTRY = resolve(RENDER_DIR, "dist/index.js");
const FONT_DIR = resolve(REPO_ROOT, "packages/fonts/pack");

const DB_READY = isDatabaseAvailable();
const STORAGE_READY = isStorageAvailable();
const FFMPEG_READY = isFfmpegAvailable();
const CAN_RUN = DB_READY && STORAGE_READY && FFMPEG_READY;

if (!CAN_RUN) {
  console.warn(
    `[exports-render.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}` +
      `${STORAGE_READY ? "" : `storage: ${storageSkipReason}. `}` +
      `${FFMPEG_READY ? "" : "ffmpeg is not on PATH."}`,
  );
}

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

describe.skipIf(!CAN_RUN)("exports — cloud render path (real apps/render worker)", () => {
  let ctx: EdgTestContext;
  let base: string;
  let rawStore: ObjectStore;
  let derivedStore: ObjectStore;
  let worker: ChildProcess | null = null;
  let fixtures: FixtureSet | null = null;
  const rawKeysWritten: string[] = [];
  const derivedKeysWritten: string[] = [];

  beforeAll(async () => {
    fixtures = await buildFixtures();

    const created = await createEdgTestContext();
    if (created === null) throw new Error(`exports-render suite could not start: ${edgSkipReason}`);
    ctx = created;
    base = `http://127.0.0.1:${String(ctx.port)}`;

    const env = resolveEnv();
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

    const free = PLAN_SEEDS.find((plan) => plan.key === "free");
    if (free === undefined) throw new Error("free plan seed missing");
    await ctx.prisma.plan.upsert({
      where: { key: "free" },
      update: {
        entitlements: free.entitlements,
        creditsPerMonthTenths: free.creditsPerMonthTenths,
      },
      create: {
        id: "01JEXPFREEPLAN00000000001",
        key: "free",
        name: free.name,
        prices: free.prices,
        creditsPerMonthTenths: free.creditsPerMonthTenths,
        entitlements: free.entitlements,
      },
    });

    // B02's real ledger enforces an actual balance: a plan alone is not
    // credits (a subscription grants one on the billing anniversary; this
    // suite has no subscription at all). Fund it through the app's own
    // CreditsFacade, not a hand-rolled row — this suite is about the cloud
    // render pipeline and its settlement, not the ledger itself, which has
    // its own `test/credits-ledger.e2e-spec.ts`.
    await fundWorkspaceCredits(ctx.app, ctx.workspaceId, AMPLE_TEST_CREDIT_TENTHS);

    // `edg-harness.ts`'s `seed()` calls `initialise` directly, so the document
    // carries `initialise`'s own default style and this suite database — unlike a
    // seeded deployment — holds no system presets. This fixture used to create a
    // "clean-bold" row because that was the default; that id ships in no package,
    // which is exactly why it was replaced by `DEFAULT_STYLE_REF`. The row now
    // matches the real default so the manifest snapshot carries a real StyleDoc.
    const existingStyle = await ctx.prisma.stylePreset.findFirst({
      where: { workspaceId: null, key: DEFAULT_STYLE_REF },
    });
    if (existingStyle === null) {
      const doc = loadSystemStyleMap().get(DEFAULT_STYLE_REF);
      if (doc === undefined) throw new Error(`${DEFAULT_STYLE_REF} system style missing`);
      await ctx.prisma.stylePreset.create({
        data: {
          id: "01JEXPSTYLEVCLEAN00000001",
          workspaceId: null,
          key: DEFAULT_STYLE_REF,
          name: "Vertical Clean",
          category: "general",
          doc: { ...doc, id: DEFAULT_STYLE_REF },
        },
      });
    }

    // The worker runs the built output, which is what a container runs.
    const build = spawnSync("pnpm", ["--filter", "@montaj/render", "build"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      shell: true,
      encoding: "utf8",
      timeout: 300_000,
    });
    if (build.status !== 0) {
      throw new Error(`apps/render build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`);
    }

    const secret = process.env["INTERNAL_CALLBACK_SECRET"] ?? "";
    const prefix = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";

    worker = spawn(process.execPath, [RENDER_ENTRY], {
      cwd: RENDER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_LEVEL: "info",
        REDIS_URL: testRedisUrl(),
        MONTAJ_QUEUE_PREFIX: prefix,
        API_ORIGIN: base,
        INTERNAL_CALLBACK_SECRET: secret,
        S3_ENDPOINT: env.S3_ENDPOINT,
        S3_REGION: env.S3_REGION,
        S3_BUCKET_RAW: env.S3_BUCKET_RAW,
        S3_ACCESS_KEY: env.S3_ACCESS_KEY,
        S3_SECRET_KEY: env.S3_SECRET_KEY,
        R2_ENDPOINT: env.R2_ENDPOINT,
        R2_BUCKET_DERIVED: env.R2_BUCKET_DERIVED,
        R2_ACCESS_KEY: env.R2_ACCESS_KEY,
        R2_SECRET_KEY: env.R2_SECRET_KEY,
        RENDER_FONT_DIR: FONT_DIR,
        RENDER_CONCURRENCY: "1",
      },
    });
    worker.stdout?.setEncoding("utf8");
    worker.stderr?.setEncoding("utf8");
    const log: string[] = [];
    worker.stdout?.on("data", (chunk: string) => log.push(chunk));
    worker.stderr?.on("data", (chunk: string) => log.push(chunk));
    (worker as unknown as { __log: string[] }).__log = log;

    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = (log.join("").match(/waiting for jobs on/g) ?? []).length;
      if (ready >= 2) break;
      if (worker.exitCode !== null || Date.now() > deadline) {
        throw new Error(`apps/render did not become ready:\n${log.join("")}`);
      }
      await new Promise((done) => setTimeout(done, 250));
    }
  }, 600_000);

  afterAll(async () => {
    worker?.kill("SIGTERM");
    await new Promise((done) => setTimeout(done, 1_500));
    if (worker !== null && worker.exitCode === null) worker.kill("SIGKILL");

    if (rawKeysWritten.length > 0) await rawStore.deleteMany(rawKeysWritten).catch(() => 0);
    if (derivedKeysWritten.length > 0)
      await derivedStore.deleteMany(derivedKeysWritten).catch(() => 0);

    await ctx?.stop();
    await fixtures?.cleanup();
  }, 120_000);

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as T };
  }

  async function waitForJob(
    projectId: string,
    type: string,
    timeoutMs = 150_000,
  ): Promise<{ id: string; status: string; result: unknown; creditsChargedTenths: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await ctx.prisma.job.findFirst({ where: { projectId, type } });
      if (job !== null && (job.status === "succeeded" || job.status === "failed")) {
        return job as unknown as {
          id: string;
          status: string;
          result: unknown;
          creditsChargedTenths: number;
        };
      }
      if (Date.now() > deadline) {
        const log = (worker as unknown as { __log?: string[] } | null)?.__log?.join("") ?? "";
        throw new Error(
          `${type} for project ${projectId} did not finish within ${String(timeoutMs)} ms. ` +
            `job=${JSON.stringify(job)}\nworker log:\n${log.slice(-4_000)}`,
        );
      }
      await new Promise((done) => setTimeout(done, 750));
    }
  }

  interface DecisionBody {
    exportId: string;
    path: "browser" | "cloud";
    reasons: string[];
    watermarked: boolean;
    job?: { jobId: string; status: string; deduplicated: boolean };
  }

  it("renders a cloud export end to end and settles the credits it actually used", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    // A real, small MP4 at the exact CONTRACTS §6 raw key the seeded row names.
    const key = (await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: seeded.mediaId } }))
      .storageKey;
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(fixtures?.video ?? "");
    await rawStore.put({ key, body: bytes, contentType: "video/mp4" });
    rawKeysWritten.push(key);

    await ctx.prisma.mediaAsset.update({
      where: { id: seeded.mediaId },
      data: {
        durationMs: VIDEO_DURATION_S * 1_000,
        width: 1_280,
        height: 720,
        fps: 30,
        hasAudio: true,
        codec: "h264",
        status: "ready",
      },
    });

    const response = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: { kind: "video", preset: "reels", outputKind: "video", mode: "cloud", script: "roman" },
    });
    expect(response.status).toBe(201);
    expect(response.body.path).toBe("cloud");
    expect(response.body.job?.jobId).toBeDefined();

    // --- the signed manifest: caps from the Free plan, watermarked -----------
    const manifestRow = await ctx.prisma.exportManifest.findFirstOrThrow({
      where: { projectId: seeded.projectId, mode: "cloud" },
      orderBy: { issuedAt: "desc" },
    });
    const secret = process.env["INTERNAL_CALLBACK_SECRET"] ?? "";
    const verified = verifyRenderManifest({ manifest: manifestRow.manifest, secret });
    expect(verified.manifest.workspaceId).toBe(ctx.workspaceId);
    expect(verified.manifest.caps.maxWidth).toBe(1_920);
    expect(verified.manifest.caps.maxHeight).toBe(1_920);
    expect(verified.manifest.caps.allowAlpha).toBe(false);
    expect(verified.manifest.watermark).toEqual({
      assetId: "aksharo-watermark",
      position: "bottom-right",
      opacity: 0.85,
    });

    // --- wait for the real worker to finish the real render ------------------
    const job = await waitForJob(seeded.projectId, "render.video");
    expect(
      job.status,
      JSON.stringify({ result: job.result, error: (job as never as { error: unknown }).error }),
    ).toBe("succeeded");

    const result = job.result as {
      outputKey: string;
      sizeBytes: number;
      outputMs: number;
      watermarked: boolean;
    };
    expect(result.watermarked).toBe(true);
    const expectedTenths = creditCostTenths({
      operation: "cloudRender",
      durationMs: result.outputMs,
    });
    expect(job.creditsChargedTenths).toBe(expectedTenths);
    expect(job.creditsChargedTenths).toBeGreaterThan(0);

    // --- the exports row, and the derived object at the CONTRACTS §6 key -----
    const exportRow = await ctx.prisma.export.findFirstOrThrow({ where: { jobId: job.id } });
    expect(exportRow.status).toBe("succeeded");
    expect(exportRow.watermarked).toBe(true);
    expect(exportRow.storageKey).toBe(
      `ws/${ctx.workspaceId}/p/${seeded.projectId}/exports/${exportRow.id}.mp4`,
    );
    expect(exportRow.sizeBytes).toBeGreaterThan(0n);
    derivedKeysWritten.push(exportRow.storageKey as string);

    const head = await derivedStore.head(exportRow.storageKey as string);
    expect(head, "the rendered file must really be in R2").not.toBeNull();
    expect(head?.sizeBytes).toBeGreaterThan(0);

    // --- a publish_events row for the streak experiment -----------------------
    const publishEvents = await ctx.prisma.publishEvent.findMany({
      where: { exportId: exportRow.id },
    });
    expect(publishEvents).toHaveLength(1);

    // --- the signed download URL really resolves ------------------------------
    const download = await call<{ url: string }>("GET", `/exports/${exportRow.id}/download`, {
      token,
    });
    expect(download.status).toBe(200);
    const fetched = await fetch(download.body.url, { method: "GET" });
    expect(fetched.status).toBe(200);
    expect(Number(fetched.headers.get("content-length") ?? "0")).toBeGreaterThan(0);
  }, 180_000);
});
