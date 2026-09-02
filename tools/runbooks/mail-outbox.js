#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; its output is the product. */
/**
 * mail-outbox — read the development mail outbox (`MAIL_PROVIDER=dev`).
 *
 * With no mail server configured, A25's `DevOutboxProvider` pushes every message
 * onto a Redis list instead of sending it. That is what makes a local sign-up
 * finish: the verification link is in the outbox, not in a mailbox. This prints
 * it, newest first.
 *
 *   node tools/runbooks/mail-outbox.js
 *   node tools/runbooks/mail-outbox.js --limit=5 --full
 *   node tools/runbooks/mail-outbox.js --kind=verify-email --json
 *   node tools/runbooks/mail-outbox.js --clear
 *
 * | Option      | Default      | Meaning                                      |
 * | ----------- | ------------ | -------------------------------------------- |
 * | `--limit=`  | 10           | how many messages to print                   |
 * | `--kind=`   |              | only this notification kind                  |
 * | `--full`    |              | print the whole text body, not the first line |
 * | `--json`    |              | machine-readable output                      |
 * | `--clear`   |              | delete the outbox and exit                   |
 * | `--redis=`  | `REDIS_URL`  | connection string                            |
 *
 * There is nothing to read in staging or production: `MAIL_PROVIDER=dev` refuses
 * to start there, precisely so a misconfigured deploy cannot silently write real
 * mail to a Redis list. Exit codes: 0 printed, 1 failed, 2 bad usage.
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, parse, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..");

// `ioredis` belongs to apps/api, not to the repo root, and pnpm's node_modules
// is strict — the same resolution trick `queue-drain.js` uses.
const apiRequire = createRequire(join(REPO_ROOT, "apps", "api", "package.json"));

/** Must match `redisKeys.devOutbox()` in `apps/api/src/auth/auth.constants.ts`. */
const OUTBOX_KEY = "montaj:auth:dev-outbox";

const DEFAULT_LIMIT = 10;

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
  const options = { limit: DEFAULT_LIMIT, kind: undefined, full: false, json: false, clear: false };
  for (const arg of argv) {
    if (arg === "--full") options.full = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--clear") options.clear = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--kind=")) options.kind = arg.slice("--kind=".length);
    else if (arg.startsWith("--redis=")) options.redis = arg.slice("--redis=".length);
    else return { error: `unknown option: ${arg}` };
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    return { error: "--limit must be a positive integer" };
  }
  return options;
}

const USAGE = [
  "usage: node tools/runbooks/mail-outbox.js [--limit=N] [--kind=K] [--full] [--json] [--clear]",
  "",
  "Prints the development mail outbox (MAIL_PROVIDER=dev), newest first.",
].join("\n");

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error !== undefined) {
    console.error(options.error);
    console.error(USAGE);
    return 2;
  }
  if (options.help === true) {
    console.log(USAGE);
    return 0;
  }

  loadDotenv(process.cwd()) ?? loadDotenv(REPO_ROOT);
  const url = options.redis ?? process.env.REDIS_URL;
  if (url === undefined || url === "") {
    console.error("REDIS_URL is not set. Copy .env.example to .env, or pass --redis=");
    return 1;
  }

  const IORedis = apiRequire("ioredis");
  const redis = new IORedis(url, { maxRetriesPerRequest: 1, lazyConnect: true });

  try {
    await redis.connect();

    if (options.clear === true) {
      const removed = await redis.del(OUTBOX_KEY);
      console.log(removed === 1 ? "outbox cleared" : "outbox was already empty");
      return 0;
    }

    const raw = await redis.lrange(OUTBOX_KEY, 0, -1);
    const messages = [];
    for (const entry of raw) {
      try {
        messages.push(JSON.parse(entry));
      } catch {
        /* a truncated entry is not worth failing the whole listing over */
      }
    }

    const filtered =
      options.kind === undefined
        ? messages
        : messages.filter((message) => message.kind === options.kind);
    const shown = filtered.slice(0, options.limit);

    if (options.json === true) {
      console.log(JSON.stringify({ total: filtered.length, messages: shown }, null, 2));
      return 0;
    }

    if (shown.length === 0) {
      console.log("outbox is empty (is MAIL_PROVIDER=dev, and is the API running?)");
      return 0;
    }

    for (const message of shown) {
      console.log("─".repeat(72));
      console.log(`${message.at ?? "?"}  ${message.kind ?? "?"}  →  ${message.to ?? "?"}`);
      console.log(`subject: ${message.subject ?? ""}`);
      if (message.link !== undefined) console.log(`link:    ${message.link}`);
      if (message.token !== undefined) console.log(`token:   ${message.token}`);
      if (options.full === true) {
        console.log("");
        console.log(message.text ?? "");
      }
    }
    console.log("─".repeat(72));
    console.log(`${shown.length} of ${filtered.length} message(s)`);
    return 0;
  } catch (error) {
    console.error(`mail-outbox: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    redis.disconnect();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
