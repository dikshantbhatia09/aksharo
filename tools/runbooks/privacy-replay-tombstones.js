#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; its output is the product. */
/**
 * privacy-replay-tombstones — re-verify (and re-run) erasure for every
 * completed `dsr_requests` row, after a restore.
 *
 * `docs/runbooks/breach-first-hour.md`'s "Getting the platform back" step 6
 * warns that `restore-from-pitr.md` "resurrects data that erasure requests
 * had removed" and says "replay the tombstones" — this is that script. Like
 * `dlq-replay.js`, it talks to the admin API over HTTP rather than to
 * Postgres directly: the policy (which models count as "personal data",
 * which are exempt as billing documents or consent tombstones, how the
 * cascade itself runs) lives in `ResidueCheckService` and
 * `ErasureCascadeService`, and a script with its own database connection
 * would be a second implementation of the same policy.
 *
 *   node tools/runbooks/privacy-replay-tombstones.js
 *   node tools/runbooks/privacy-replay-tombstones.js --json
 *   node tools/runbooks/privacy-replay-tombstones.js --api=https://api.example.com --token=...
 *
 * It calls `POST /admin/privacy/erasure/replay-tombstones`, which:
 *
 *   1. finds every `dsr_requests` row of kind `erasure` and status `completed`;
 *   2. for each, sweeps every model with a `userId`/`workspaceId` column for
 *      residue (the same check `erasure-sweep.e2e-spec.ts` runs);
 *   3. if any residue is found, re-runs the erasure cascade for that user and
 *      re-checks — a PITR restore can only ever resurrect rows, and the
 *      cascade is idempotent (a rerun over already-gone rows is a no-op), so
 *      "found residue, reran, recheck" is safe to do unconditionally.
 *
 * Exit codes: 0 nothing was found (or everything found was cleared), 1 the
 * API refused or residue remained after a replay, 2 bad usage.
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { dirname, join, parse, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..");

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

const USAGE = `
privacy-replay-tombstones — re-verify erasure for every completed DSR request.

Usage:
  node tools/runbooks/privacy-replay-tombstones.js [options]

Connection    --api=<url>   (or API_ORIGIN)
              --token=<jwt> (or MONTAJ_ADMIN_TOKEN)
Output        --json
`.trim();

function parseArgs(argv) {
  const options = { api: undefined, token: undefined, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--api=")) options.api = arg.slice(6);
    else if (arg.startsWith("--token=")) options.token = arg.slice(8);
    else throw new UsageError(`Unknown option "${arg}".`);
  }
  return options;
}

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
    const result = await call(options, "POST", "/admin/privacy/erasure/replay-tombstones", {
      body: {},
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`checked ${result.checked} completed erasure request(s)`);
      let residual = 0;
      for (const row of result.results) {
        if (!row.replayed) continue;
        console.log(
          `  ${row.userId}: residue ${row.residueBefore} -> ${row.residueAfter}` +
            (row.residueAfter > 0 ? "  STILL PRESENT" : "  cleared"),
        );
        if (row.residueAfter > 0) residual += 1;
      }
      if (residual === 0) {
        console.log("no residue left after replay.");
      }
      return residual > 0 ? 1 : 0;
    }
    return result.results.some((row) => row.replayed && row.residueAfter > 0) ? 1 : 0;
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
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  },
);
