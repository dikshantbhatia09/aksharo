#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; its output is the product. */
/**
 * credits-orphaned-holds — find `credit_holds` still `held` whose job has
 * already reached a terminal status, and resolve each one per the job's
 * outcome.
 *
 * The command `docs/runbooks/credits-orphaned-holds.md` is written around. Like
 * `dlq-replay.js`, it talks to the admin API (`/admin/credits/orphaned-holds`,
 * B02) rather than to Postgres directly: resolving a hold is a `settle` or a
 * `release` through `LedgerCreditsFacade`, and a script with its own database
 * connection would be a second, drifting implementation of that policy.
 *
 *   node tools/runbooks/credits-orphaned-holds.js list
 *   node tools/runbooks/credits-orphaned-holds.js resolve
 *   node tools/runbooks/credits-orphaned-holds.js resolve --confirm
 *   node tools/runbooks/credits-orphaned-holds.js resolve --ids=a,b --confirm
 *
 * | Command   | What it does                                                       |
 * | --------- | ------------------------------------------------------------------- |
 * | `list`    | every orphaned hold: job, queue, amount, how long it has been held  |
 * | `resolve` | settle a succeeded job's hold, release everything else — **dry run  |
 * |           | unless `--confirm`**                                                |
 *
 * | Option       | Default               | Meaning                              |
 * | ------------ | ---------------------- | ------------------------------------ |
 * | `--api=`     | `API_ORIGIN`           | API base URL                         |
 * | `--token=`   | `MONTAJ_ADMIN_TOKEN`   | admin access token                   |
 * | `--ids=`     |                        | comma-separated hold ids (`resolve`) |
 * | `--dry-run`  | **on** for `resolve`   | report, change nothing               |
 * | `--confirm`  |                        | turn the dry run off                 |
 * | `--json`     |                        | machine-readable output              |
 *
 * Exit codes: 0 done, 1 the API refused or some entries failed, 2 bad usage.
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, parse, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..");
const COMMANDS = ["list", "resolve"];

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
    ids: [],
    dryRun: true,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--confirm") options.dryRun = false;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--api=")) options.api = arg.slice(6);
    else if (arg.startsWith("--token=")) options.token = arg.slice(8);
    else if (arg.startsWith("--ids=")) {
      options.ids = arg
        .slice(6)
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".`);
    else if (options.command === undefined) options.command = arg;
    else throw new UsageError(`Unexpected argument "${arg}".`);
  }

  if (options.help) return options;
  if (options.command === undefined) throw new UsageError("A command is required.");
  if (!COMMANDS.includes(options.command)) {
    throw new UsageError(`"${options.command}" is not a command. One of: ${COMMANDS.join(", ")}.`);
  }
  return options;
}

const USAGE = `
credits-orphaned-holds — find and resolve holds a completion callback never settled.

  node tools/runbooks/credits-orphaned-holds.js <command> [options]

Commands
  list      every hold still \`held\` whose job already finished
  resolve   settle a succeeded job's hold, release everything else   [dry run unless --confirm]

Targeting     --ids=<hold id>,<hold id>   (resolve only; omit to resolve every orphan)
Behaviour     --confirm  --dry-run  --json
Connection    --api=<url>   (or API_ORIGIN)
              --token=<jwt> (or MONTAJ_ADMIN_TOKEN)
`.trim();

/** One request to the admin API. Throws {@link ApiError} on a non-2xx. */
async function call(options, method, path, { body } = {}) {
  const url = new URL(path, options.api);
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

async function runList(options) {
  const holds = await call(options, "GET", "/admin/credits/orphaned-holds");
  if (options.json) {
    console.log(JSON.stringify(holds, null, 2));
    return 0;
  }
  if (holds.length === 0) {
    console.log("no orphaned holds");
    return 0;
  }
  console.log(
    `${short("HOLD", 26)}  ${short("JOB", 26)}  ${short("QUEUE", 16)}  ` +
      `${short("JOB STATUS", 10)}  ${short("TENTHS", 7)}  HELD SINCE`,
  );
  for (const hold of holds) {
    console.log(
      `${short(hold.holdId, 26)}  ${short(hold.jobId, 26)}  ${short(hold.queue, 16)}  ` +
        `${short(hold.jobStatus, 10)}  ${short(hold.amountTenths, 7)}  ${hold.heldSince}`,
    );
  }
  console.log(`\n${holds.length} orphaned hold(s)`);
  return 0;
}

async function runResolve(options) {
  const body = {
    dryRun: options.dryRun,
    ...(options.ids.length > 0 ? { holdIds: options.ids } : {}),
  };
  const results = await call(options, "POST", "/admin/credits/orphaned-holds/resolve", { body });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    if (results.length === 0) {
      console.log("nothing to resolve");
    }
    for (const result of results) {
      console.log(
        `${short(result.action, 14)}  ${short(result.holdId, 26)}  ${short(result.jobId, 26)}  ` +
          `${short(result.queue, 16)}${result.error === undefined ? "" : `  ${result.error}`}`,
      );
    }
    const failed = results.filter((r) => r.action === "failed").length;
    console.log(`\n${results.length} hold(s); ${failed} failed`);
    if (options.dryRun) console.log("DRY RUN — nothing was changed. Add --confirm to act.");
  }
  return results.some((r) => r.action === "failed") ? 1 : 0;
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
    if (options.command === "list") return await runList(options);
    return await runResolve(options);
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
