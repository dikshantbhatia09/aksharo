#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI whose stdout is its result. */
/**
 * Harness for the A09 integration test: the Node half of one real job.
 *
 * The Python worker cannot create a `jobs` row (it has no database driver, by
 * design — a worker never touches Postgres, CONTRACTS §3), and the API exposes no
 * public "enqueue this" endpoint. So this script plays the producer, using the
 * API's **own** contract modules rather than a re-implementation of them:
 * `buildJobEnvelope`, `bullJobId` and `retryPolicyFor` are imported from
 * `apps/api/dist`, so if A08 changes the envelope this harness changes with it.
 *
 *   node scripts/integration-job.mjs seed  --type ai.transcribe --payload '{...}'
 *   node scripts/integration-job.mjs check --job 01J...
 *
 * `seed` prints `{jobId, attemptId, bullJobId, workspaceId, projectId}` as JSON;
 * `check` prints the row the API wrote. Both are idempotent enough to re-run.
 *
 * Requires `DATABASE_URL`, `REDIS_URL` and (optionally) `MONTAJ_QUEUE_PREFIX` —
 * point the first at `montaj_a09` and the last at `a09` so a parallel agent's
 * queues and rows are never touched.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(APP_DIR, "..", "..");
const API_DIR = join(REPO_ROOT, "apps", "api");

// `@prisma/client`, `bullmq` and `ioredis` belong to apps/api, and pnpm's
// node_modules is strict — the same trick `tools/runbooks/*.js` uses.
const apiRequire = createRequire(join(API_DIR, "package.json"));

/** Crockford base32 (no I, L, O, U) — CONTRACTS §0 ids are ULIDs. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** @param {string} prefix */
function ulid(prefix = "") {
  let out = prefix;
  const now = Date.now();
  for (let value = now; out.length < 12; value = Math.floor(value / 32)) {
    out += CROCKFORD[value % 32];
  }
  while (out.length < 26) {
    out += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return out.slice(0, 26);
}

/** Deterministic ids so re-running the harness reuses one workspace and project. */
const FIXTURE = {
  user: "01JA09USER0000000000000000",
  workspace: "01JA09WORKSPACE00000000000",
  project: "01JA09PROJECT000000000000A",
};

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

async function loadContracts() {
  // The API's compiled contract modules. `pnpm --filter @montaj/api build` puts
  // them here; the test skips with this message if it has not been run.
  const envelope = await import(
    `file://${join(API_DIR, "dist", "jobs", "contracts", "job-envelope.js").replaceAll("\\", "/")}`
  );
  const registry = await import(
    `file://${join(API_DIR, "dist", "jobs", "queue.registry.js").replaceAll("\\", "/")}`
  );
  const config = await import(
    `file://${join(API_DIR, "dist", "jobs", "jobs.config.js").replaceAll("\\", "/")}`
  );
  return {
    buildJobEnvelope: envelope.buildJobEnvelope,
    bullJobId: registry.bullJobId,
    retryPolicyFor: config.retryPolicyFor,
    queuePrefix: config.queuePrefix,
  };
}

/** Ensure the tenancy rows a `jobs` row needs. Idempotent. */
async function ensureFixtures(prisma) {
  await prisma.user.upsert({
    where: { id: FIXTURE.user },
    update: {},
    create: {
      id: FIXTURE.user,
      email: "a09-integration@example.invalid",
      name: "A09 integration",
    },
  });
  await prisma.workspace.upsert({
    where: { id: FIXTURE.workspace },
    update: {},
    create: {
      id: FIXTURE.workspace,
      slug: "a09-integration",
      name: "A09 integration",
      ownerId: FIXTURE.user,
      billingCountry: "IN",
    },
  });
  await prisma.project.upsert({
    where: { id: FIXTURE.project },
    update: {},
    create: {
      id: FIXTURE.project,
      workspaceId: FIXTURE.workspace,
      title: "A09 integration",
    },
  });
}

async function seed(flags) {
  const { PrismaClient } = apiRequire("@prisma/client");
  const { Queue } = apiRequire("bullmq");
  const IORedis = apiRequire("ioredis");
  const contracts = await loadContracts();

  const type = flags["type"] ?? "ai.transcribe";
  const payload = JSON.parse(flags["payload"] ?? "{}");
  const prefix = contracts.queuePrefix(process.env);

  const prisma = new PrismaClient();
  const redis = new IORedis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(type, { connection: redis, prefix });

  try {
    await ensureFixtures(prisma);

    const jobId = ulid("01JA09J");
    const attemptId = ulid("01JA09A");
    const jobKey = `a09-integration:${jobId}`;
    const priority = 3;

    await prisma.job.create({
      data: {
        id: jobId,
        workspaceId: FIXTURE.workspace,
        projectId: FIXTURE.project,
        type,
        status: "queued",
        priority,
        params: payload,
        jobKey,
        attemptId,
      },
    });

    const envelope = contracts.buildJobEnvelope({
      jobId,
      attemptId,
      workspaceId: FIXTURE.workspace,
      projectId: FIXTURE.project,
      priority,
      jobKey,
      createdAt: new Date(),
      payload,
    });

    const policy = contracts.retryPolicyFor(type);
    await queue.add(type, envelope, {
      jobId: contracts.bullJobId(jobId, attemptId),
      priority,
      attempts: policy.attempts,
      backoff: { type: "exponential", delay: policy.backoffMs },
    });

    console.log(
      JSON.stringify({
        jobId,
        attemptId,
        bullJobId: contracts.bullJobId(jobId, attemptId),
        workspaceId: FIXTURE.workspace,
        projectId: FIXTURE.project,
        queue: type,
        prefix,
      }),
    );
  } finally {
    await queue.close();
    redis.disconnect();
    await prisma.$disconnect();
  }
}

async function check(flags) {
  const { PrismaClient } = apiRequire("@prisma/client");
  const jobId = flags["job"];
  if (jobId === undefined) {
    console.error("--job is required");
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (job === null) {
      console.log(JSON.stringify({ found: false }));
      return;
    }
    // `job_events` has no `name` column: the event name lives in `data.event`
    // (see `JobEventsService.row`), which is what A08b's DLQ backfill reads too.
    const events = await prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { at: "asc" },
      select: { data: true },
    });
    console.log(
      JSON.stringify({
        found: true,
        status: job.status,
        progress: job.progress,
        provider: job.provider,
        model: job.model,
        costMinor: job.costMinor,
        creditsChargedTenths: job.creditsChargedTenths,
        error: job.error,
        result: job.result,
        events: events.map((event) => event.data?.event ?? null),
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

try {
  if (command === "seed") await seed(flags);
  else if (command === "check") await check(flags);
  else {
    console.error("usage: integration-job.mjs seed|check [--type] [--payload] [--job]");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
