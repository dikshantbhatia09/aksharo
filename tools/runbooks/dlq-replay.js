#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; its output is the product. */
/**
 * dlq-replay — inspect, replay and discard dead-lettered jobs.
 *
 * The command `docs/runbooks/dlq-replay.md` is written around. It talks to the
 * admin DLQ API (`/admin/dlq`, A08b) over HTTP rather than to Postgres directly,
 * for one reason that matters: a replay has to reserve credits, mint a fresh
 * attempt, add a BullMQ job and write an audit row, and every one of those rules
 * lives in `DlqService`. A script with its own database connection would be a
 * second implementation of the same policy, and the day they disagree is the day
 * an operator is looking at an incident.
 *
 *   node tools/runbooks/dlq-replay.js stats
 *   node tools/runbooks/dlq-replay.js list --queue=ai.transcribe --limit=20 --show-error
 *   node tools/runbooks/dlq-replay.js replay --queue=ai.transcribe --since=2026-09-02T08:00:00Z
 *   node tools/runbooks/dlq-replay.js replay --job=01JD... --confirm
 *   node tools/runbooks/dlq-replay.js discard --ids=a,b --reason="unsupported input" --confirm
 *
 * | Command    | What it does                                                     |
 * | ---------- | ---------------------------------------------------------------- |
 * | `stats`    | per-queue: how many, since when, how many distinct errors        |
 * | `list`     | the entries themselves, newest first                             |
 * | `show`     | one entry in full, payload and error included                    |
 * | `replay`   | re-enqueue with a fresh attempt; **dry run unless `--confirm`**  |
 * | `discard`  | give up, release the hold, record why; needs `--reason`          |
 *
 * | Option           | Default                       | Meaning                        |
 * | ---------------- | ----------------------------- | ------------------------------ |
 * | `--api=`         | `API_ORIGIN`                  | API base URL                   |
 * | `--token=`       | `MONTAJ_ADMIN_TOKEN`          | admin access token             |
 * | `--queue=`       |                               | one of the CONTRACTS §3 queues |
 * | `--job=`         |                               | a job id, or an entry id       |
 * | `--ids=`         |                               | comma-separated ids            |
 * | `--reason=`      |                               | discard reason (required)      |
 * | `--grep=`        |                               | filter on the last error text  |
 * | `--since=`       |                               | ISO-8601 instant               |
 * | `--until=`       |                               | ISO-8601 instant               |
 * | `--status=`      | `pending` for list            | pending, replayed, discarded   |
 * | `--limit=`       | 25 (list), 25 (bulk)          | how many                       |
 * | `--dry-run`      | **on** for replay/discard     | report, change nothing         |
 * | `--confirm`      |                               | turn the dry run off           |
 * | `--show-error`   |                               | print each entry's last error  |
 * | `--json`         |                               | machine-readable output        |
 *
 * Exit codes: 0 done, 1 the API refused or some entries failed, 2 bad usage.
 * The companion script is `tools/runbooks/queue-drain.js` (A08).
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, parse, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..");

/** The queue table of docs/CONTRACTS.md §3. */
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
];

const COMMANDS = ["stats", "list", "show", "replay", "discard"];
const STATUSES = ["pending", "replayed", "discarded"];
const DEFAULT_LIMIT = 25;

class UsageError extends Error {}
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
    command: undefined,
    api: undefined,
    token: undefined,
    queue: undefined,
    job: undefined,
    ids: [],
    reason: undefined,
    grep: undefined,
    since: undefined,
    until: undefined,
    status: undefined,
    limit: undefined,
    // A replay or a discard is a dry run until somebody types --confirm.
    dryRun: true,
    showError: false,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--confirm") options.dryRun = false;
    else if (arg === "--show-error") options.showError = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--api=")) options.api = arg.slice(6);
    else if (arg.startsWith("--token=")) options.token = arg.slice(8);
    else if (arg.startsWith("--queue=")) options.queue = arg.slice(8);
    else if (arg.startsWith("--job=")) options.job = arg.slice(6);
    else if (arg.startsWith("--ids=")) {
      options.ids = arg
        .slice(6)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
    } else if (arg.startsWith("--reason=")) options.reason = arg.slice(9);
    else if (arg.startsWith("--grep=")) options.grep = arg.slice(7);
    else if (arg.startsWith("--since=")) options.since = arg.slice(8);
    else if (arg.startsWith("--until=")) options.until = arg.slice(8);
    else if (arg.startsWith("--status=")) options.status = arg.slice(9);
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice(8));
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".`);
    else if (options.command === undefined) options.command = arg;
    else if (options.job === undefined) options.job = arg;
    else throw new UsageError(`Unexpected argument "${arg}".`);
  }

  if (options.help) return options;
  if (options.command === undefined) throw new UsageError("A command is required.");
  if (!COMMANDS.includes(options.command)) {
    throw new UsageError(`"${options.command}" is not a command. One of: ${COMMANDS.join(", ")}.`);
  }
  if (options.queue !== undefined && !QUEUE_NAMES.includes(options.queue)) {
    throw new UsageError(
      `"${options.queue}" is not a known queue. One of:\n  ${QUEUE_NAMES.join("\n  ")}`,
    );
  }
  if (options.status !== undefined && !STATUSES.includes(options.status)) {
    throw new UsageError(`--status must be one of: ${STATUSES.join(", ")}.`);
  }
  for (const [name, value] of [
    ["--since", options.since],
    ["--until", options.until],
  ]) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new UsageError(`${name} must be an ISO-8601 instant, e.g. 2026-09-02T08:00:00Z.`);
    }
  }
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
    throw new UsageError("--limit must be a positive number.");
  }
  if (options.command === "show" && options.job === undefined) {
    throw new UsageError("show needs --job=<entry id or job id>.");
  }
  if (options.command === "discard" && (options.reason ?? "").trim() === "") {
    throw new UsageError(
      "discard needs --reason=\"...\". The DLQ is also the record of what the system could not do.",
    );
  }
  if (
    (options.command === "replay" || options.command === "discard") &&
    options.job === undefined &&
    options.ids.length === 0 &&
    options.queue === undefined &&
    options.since === undefined &&
    options.grep === undefined
  ) {
    throw new UsageError(
      `${options.command} needs a target: --job=, --ids=, --queue=, --since= or --grep=. ` +
        "Refusing to act on the whole dead-letter queue.",
    );
  }
  return options;
}

const USAGE = `
dlq-replay — inspect, replay and discard dead-lettered jobs.

  node tools/runbooks/dlq-replay.js <command> [options]

Commands
  stats     per-queue counts, oldest failure, distinct error codes
  list      the entries themselves, newest first
  show      one entry in full (--job=<entry id or job id>)
  replay    re-enqueue with a fresh attempt   [dry run unless --confirm]
  discard   release the hold and record why   [dry run unless --confirm]

Targeting     --job=<id>  --ids=a,b  --queue=<q>  --since=<iso>  --until=<iso>
              --grep=<text in the last error>  --status=pending|replayed|discarded
Behaviour     --confirm  --dry-run  --limit=n  --show-error  --json
Connection    --api=<url>   (or API_ORIGIN)
              --token=<jwt> (or MONTAJ_ADMIN_TOKEN)

Queues: ${QUEUE_NAMES.join(", ")}
`.trim();

/** One request to the admin API. Throws {@link ApiError} on a non-2xx. */
async function call(options, method, path, { query, body } = {}) {
  const url = new URL(path, options.api);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const error = parsed.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? String(response.status),
      error.message ?? text.slice(0, 300),
    );
  }
  return parsed;
}

function short(value, length) {
  const text = String(value ?? "");
  return text.length <= length ? text.padEnd(length) : `${text.slice(0, length - 1)}…`;
}

function errorText(entry) {
  const last = entry.lastError;
  if (last === null || last === undefined) return "—";
  return `${last.code ?? "?"}: ${last.message ?? ""}`;
}

function printEntries(entries, options) {
  if (entries.length === 0) {
    console.log("no entries");
    return;
  }
  console.log(
    `${short("ENTRY", 26)}  ${short("JOB", 26)}  ${short("QUEUE", 16)}  ` +
      `${short("ATT", 5)}  ${short("STATUS", 9)}  FAILED AT`,
  );
  for (const entry of entries) {
    console.log(
      `${short(entry.id, 26)}  ${short(entry.jobId, 26)}  ${short(entry.queue, 16)}  ` +
        `${short(`${entry.attemptNo}/${entry.attempts}`, 5)}  ${short(entry.status, 9)}  ` +
        `${entry.failedAt}`,
    );
    if (options.showError) console.log(`  ${errorText(entry)}`);
  }
}

async function runStats(options) {
  const body = await call(options, "GET", "/admin/dlq/stats");
  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  if (body.queues.length === 0) {
    console.log("the dead-letter queue is empty");
    return 0;
  }
  console.log(
    `${short("QUEUE", 18)}  ${short("PENDING", 8)}  ${short("REPLAYED", 9)}  ` +
      `${short("DISCARDED", 10)}  ${short("ERRORS", 7)}  OLDEST PENDING`,
  );
  for (const row of body.queues) {
    console.log(
      `${short(row.queue, 18)}  ${short(row.pending, 8)}  ${short(row.replayed, 9)}  ` +
        `${short(row.discarded, 10)}  ${short(row.distinctErrors, 7)}  ` +
        `${row.oldestFailedAt ?? "—"}`,
    );
  }
  console.log(`\n${body.pending} pending in total`);
  return 0;
}

async function runList(options) {
  const body = await call(options, "GET", "/admin/dlq", {
    query: {
      queue: options.queue,
      status: options.status ?? "pending",
      reason: options.grep,
      since: options.since,
      until: options.until,
      limit: String(options.limit ?? DEFAULT_LIMIT),
    },
  });
  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  printEntries(body.items, options);
  if (body.nextCursor !== null) console.log(`\n… more; next cursor ${body.nextCursor}`);
  return 0;
}

async function runShow(options) {
  const entry = await call(options, "GET", `/admin/dlq/${encodeURIComponent(options.job)}`);
  console.log(JSON.stringify(entry, null, 2));
  return 0;
}

/** A single-target replay or discard: the `{id}` routes, not the bulk ones. */
async function runOne(options) {
  const path = `/admin/dlq/${encodeURIComponent(options.job)}/${options.command}`;
  const body = options.command === "discard" ? { reason: options.reason } : undefined;
  const result = await call(options, "POST", path, { body });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (options.command === "replay") {
    console.log(
      `replayed ${result.jobId} on ${result.queue} as attempt ${result.attemptNo} ` +
        `(${result.attemptId})`,
    );
  } else {
    console.log(
      `discarded ${result.jobId} on ${result.queue}: ${result.reason}` +
        `${result.holdReleased ? " (hold released)" : ""}`,
    );
  }
  return 0;
}

async function runBulk(options) {
  const body = {
    dryRun: options.dryRun,
    ...(options.ids.length > 0 ? { ids: options.ids } : {}),
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...(options.grep === undefined ? {} : { reason: options.grep }),
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.command === "discard" ? { discardReason: options.reason } : {}),
  };
  const result = await call(options, "POST", `/admin/dlq/${options.command}`, { body });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const entry of result.entries) {
      console.log(
        `${short(entry.outcome, 14)}  ${short(entry.jobId, 26)}  ${short(entry.queue, 16)}` +
          `${entry.error === undefined ? "" : `  ${entry.error}`}`,
      );
    }
    console.log(
      `\nselected ${result.selected}  replayed ${result.replayed}  ` +
        `discarded ${result.discarded}  failed ${result.failed}`,
    );
    if (result.dryRun) {
      console.log("DRY RUN — nothing was changed. Add --confirm to act.");
    }
  }
  return result.failed > 0 ? 1 : 0;
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
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  loadDotenv(process.cwd());
  loadDotenv(REPO_ROOT);

  options.api = options.api ?? process.env.API_ORIGIN;
  options.token = options.token ?? process.env.MONTAJ_ADMIN_TOKEN;
  if (options.api === undefined || options.api === "") {
    console.error("API_ORIGIN is not set. Pass --api=https://api.example.com or fill in .env.");
    return 2;
  }
  if (options.token === undefined || options.token === "") {
    console.error(
      "No admin token. Pass --token=<access token> or set MONTAJ_ADMIN_TOKEN.\n" +
        "It must belong to a user with users.is_admin = true.",
    );
    return 2;
  }

  try {
    if (options.command === "stats") return await runStats(options);
    if (options.command === "list") return await runList(options);
    if (options.command === "show") return await runShow(options);
    // One explicit target and no dry run: use the single-entry route, so the
    // outcome names the attempt it minted.
    if (options.job !== undefined && options.ids.length === 0 && !options.dryRun) {
      return await runOne(options);
    }
    return await runBulk(options);
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`${error.status} ${error.code}: ${error.message}`);
      if (error.status === 403) {
        console.error("The token is valid but the user is not an administrator.");
      }
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
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
