#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; its output is the product. */
/**
 * queue-drain — pause a BullMQ queue and wait for its in-flight jobs to finish.
 *
 * The first step of every runbook that takes workers away: a deploy that changes
 * a processor, a Redis maintenance window, a provider incident where the safe
 * move is to stop feeding a queue rather than to fail what is already running.
 *
 * Pausing a BullMQ queue stops workers picking up *new* jobs; it does not touch
 * the ones already running. So this waits for `active` to reach zero, and if it
 * has not by the timeout it says so and exits non-zero rather than pretending the
 * queue is quiet.
 *
 * The queue stays paused afterwards — that is the point. `--resume` puts it back.
 *
 *   node tools/runbooks/queue-drain.js ai.transcribe
 *   node tools/runbooks/queue-drain.js ai.transcribe --timeout=300000
 *   node tools/runbooks/queue-drain.js ai.transcribe --status
 *   node tools/runbooks/queue-drain.js ai.transcribe --resume
 *
 * | Option        | Default                         | Meaning                          |
 * | ------------- | ------------------------------- | -------------------------------- |
 * | `--timeout=`  | 120000                          | ms to wait for active to hit 0   |
 * | `--poll=`     | 1000                            | ms between count checks          |
 * | `--prefix=`   | `MONTAJ_QUEUE_PREFIX` or `bull` | Redis key prefix                 |
 * | `--redis=`    | `REDIS_URL`                     | connection string                |
 * | `--status`    |                                 | print counts, change nothing     |
 * | `--resume`    |                                 | unpause instead of draining      |
 * | `--json`      |                                 | machine-readable output          |
 *
 * Exit codes: 0 drained (or resumed, or reported), 1 timed out or failed,
 * 2 bad usage. The companion script for the dead-letter queue is
 * `tools/runbooks/dlq-replay.js` (A08b).
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, parse, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..");

// `bullmq` and `ioredis` belong to apps/api, not to the repo root, and pnpm's
// node_modules is strict. Resolving from the API's own manifest is what makes
// this runnable as `node tools/runbooks/queue-drain.js` from anywhere.
const apiRequire = createRequire(join(REPO_ROOT, "apps", "api", "package.json"));

/** The queue table of docs/CONTRACTS.md §3, plus the API's internal scheduler queue. */
const QUEUE_NAMES = [
  "media.probe",
  "media.proxy",
  "ai.vad",
  "ai.transcribe",
  "ai.align",
  "ai.diarise",
  "ai.translate",
  "ai.transliterate",
  "ai.clean",
  "ai.pass",
  "ai.llm",
  "render.video",
  "render.subtitle",
  "notify",
  "scheduler",
];

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 1_000;

/** Load the nearest `.env` walking up from `start`, without overriding real env vars. */
function loadDotenv(start) {
  let dir = resolve(start);
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
        const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (match === null) continue;
        const [, name, rawValue] = match;
        if (process.env[name] !== undefined) continue;
        process.env[name] = rawValue.trim().replace(/^["'](.*)["']$/s, "$1");
      }
      return candidate;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseArgs(argv) {
  const options = {
    queue: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    prefix: undefined,
    redis: undefined,
    status: false,
    resume: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "--status") options.status = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--timeout=")) options.timeoutMs = Number(arg.slice(10));
    else if (arg.startsWith("--poll=")) options.pollMs = Number(arg.slice(7));
    else if (arg.startsWith("--prefix=")) options.prefix = arg.slice(9);
    else if (arg.startsWith("--redis=")) options.redis = arg.slice(8);
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".`);
    else if (options.queue === undefined) options.queue = arg;
    else throw new UsageError(`Unexpected argument "${arg}".`);
  }

  if (options.help === true) return options;
  if (options.queue === undefined) throw new UsageError("A queue name is required.");
  if (!QUEUE_NAMES.includes(options.queue)) {
    throw new UsageError(
      `"${options.queue}" is not a known queue. One of:\n  ${QUEUE_NAMES.join("\n  ")}`,
    );
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new UsageError("--timeout must be a non-negative number of milliseconds.");
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs < 50) {
    throw new UsageError("--poll must be at least 50 milliseconds.");
  }
  if (options.status && options.resume) {
    throw new UsageError("--status and --resume are mutually exclusive.");
  }
  return options;
}

class UsageError extends Error {}

const USAGE = `
queue-drain — pause a BullMQ queue and wait for its in-flight jobs to finish.

  node tools/runbooks/queue-drain.js <queue> [--timeout=ms] [--poll=ms]
                                             [--prefix=p] [--redis=url]
                                             [--status] [--resume] [--json]

Queues: ${QUEUE_NAMES.join(", ")}
`.trim();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function counts(queue) {
  const raw = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "completed",
    "failed",
    "paused",
  );
  return {
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    delayed: raw.delayed ?? 0,
    completed: raw.completed ?? 0,
    failed: raw.failed ?? 0,
    paused: raw.paused ?? 0,
  };
}

function report(options, result) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { counts: c } = result;
  console.log(`queue     ${result.queue}  (prefix ${result.prefix})`);
  console.log(`state     ${result.state}`);
  if (result.waitedMs !== undefined) console.log(`waited    ${result.waitedMs} ms`);
  console.log(
    `counts    waiting ${c.waiting}  active ${c.active}  delayed ${c.delayed}  ` +
      `paused ${c.paused}  completed ${c.completed}  failed ${c.failed}`,
  );
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help === true) {
    console.log(USAGE);
    return 0;
  }

  loadDotenv(process.cwd());
  loadDotenv(REPO_ROOT);

  const url = options.redis ?? process.env.REDIS_URL;
  if (url === undefined || url === "") {
    console.error("REDIS_URL is not set. Pass --redis=redis://host:port or fill in .env.");
    return 2;
  }
  const prefix = options.prefix ?? process.env.MONTAJ_QUEUE_PREFIX ?? "bull";

  const { Queue } = apiRequire("bullmq");
  const IORedis = apiRequire("ioredis");
  // BullMQ blocks on Redis, so retries-per-request must be off.
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  connection.on("error", () => {
    /* reported by the operation that fails */
  });
  const queue = new Queue(options.queue, { connection, prefix });

  let exitCode = 0;
  try {
    if (options.status) {
      report(options, {
        queue: options.queue,
        prefix,
        state: (await queue.isPaused()) ? "paused" : "running",
        counts: await counts(queue),
      });
      return 0;
    }

    if (options.resume) {
      await queue.resume();
      report(options, {
        queue: options.queue,
        prefix,
        state: "resumed",
        counts: await counts(queue),
      });
      return 0;
    }

    await queue.pause();
    const startedAt = Date.now();
    let current = await counts(queue);
    while (current.active > 0 && Date.now() - startedAt < options.timeoutMs) {
      await sleep(options.pollMs);
      current = await counts(queue);
    }
    const waitedMs = Date.now() - startedAt;
    const drained = current.active === 0;
    if (!drained) exitCode = 1;

    report(options, {
      queue: options.queue,
      prefix,
      state: drained ? "drained (still paused)" : "timed out (still paused, jobs still active)",
      waitedMs,
      counts: current,
    });
    if (!drained) {
      console.error(
        `${current.active} job(s) were still active after ${waitedMs} ms. ` +
          "The queue is paused; wait longer, or resume it with --resume.",
      );
    }
    return exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
