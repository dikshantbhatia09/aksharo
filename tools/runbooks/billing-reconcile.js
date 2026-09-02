#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; its output is the product. */
/**
 * billing-reconcile — run `reconcile(accountId)` across every credit account,
 * or one, and print the drift.
 *
 * The command `docs/runbooks/billing-reconcile.md` is written around, and the
 * script B16's nightly reconciliation job's alert points an operator at. It
 * drives `/admin/credits/reconcile[/:accountId]` (B02) rather than querying
 * Postgres directly, so the comparison (`balance_tenths` vs `Σ credit_lots.
 * remaining_tenths` vs `Σ credit_ledger.delta_tenths`, 06 invariant 1) is
 * computed exactly once, by `CreditReconcileService`.
 *
 * **Detection only.** This script never writes anything — there is no
 * `--confirm`. A mismatch means the three numbers that are supposed to be
 * inseparable came apart, and only a human who can see which one is wrong
 * should touch the database.
 *
 *   node tools/runbooks/billing-reconcile.js
 *   node tools/runbooks/billing-reconcile.js --account=01JD7QK2…
 *   node tools/runbooks/billing-reconcile.js --json
 *
 * | Option       | Default               | Meaning                          |
 * | ------------ | ---------------------- | -------------------------------- |
 * | `--api=`     | `API_ORIGIN`           | API base URL                     |
 * | `--token=`   | `MONTAJ_ADMIN_TOKEN`   | admin access token               |
 * | `--account=` |                        | one account id; omit for every one |
 * | `--json`     |                        | machine-readable output          |
 *
 * Exit codes: 0 every account reconciles, 1 at least one is in drift (or the
 * API refused), 2 bad usage.
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

function parseArgs(argv) {
  const options = {
    api: undefined,
    token: undefined,
    account: undefined,
    json: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--api=")) options.api = arg.slice(6);
    else if (arg.startsWith("--token=")) options.token = arg.slice(8);
    else if (arg.startsWith("--account=")) options.account = arg.slice(10);
    else throw new UsageError(`Unknown option "${arg}".`);
  }
  return options;
}

const USAGE = `
billing-reconcile — recompute Σ lots and Σ ledger against the cached balance (06 invariant 1).

  node tools/runbooks/billing-reconcile.js [options]

Options
  --account=<id>   one credit account; omit to check every account
  --json           machine-readable output
  --api=<url>      (or API_ORIGIN)
  --token=<jwt>    (or MONTAJ_ADMIN_TOKEN)

Detection only. Nothing here writes to the database.
`.trim();

async function call(options, path) {
  const url = new URL(path, options.api);
  const response = await fetch(url, { headers: { authorization: `Bearer ${options.token}` } });
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

function printRows(rows, options) {
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(
    `${short("ACCOUNT", 26)}  ${short("WORKSPACE", 26)}  ${short("BALANCE", 9)}  ` +
      `${short("Σ LOTS", 9)}  ${short("Σ LEDGER", 9)}  OK`,
  );
  for (const row of rows) {
    console.log(
      `${short(row.accountId, 26)}  ${short(row.workspaceId, 26)}  ${short(row.balanceTenths, 9)}  ` +
        `${short(row.lotsSumTenths, 9)}  ${short(row.ledgerSumTenths, 9)}  ${row.ok ? "yes" : "NO"}`,
    );
    if (!row.ok) {
      console.log(
        `  drift: lots ${row.lotsDriftTenths >= 0 ? "+" : ""}${row.lotsDriftTenths}` +
          `  ledger ${row.ledgerDriftTenths >= 0 ? "+" : ""}${row.ledgerDriftTenths}`,
      );
    }
  }
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
    const rows =
      options.account === undefined
        ? await call(options, "/admin/credits/reconcile")
        : [await call(options, `/admin/credits/reconcile/${encodeURIComponent(options.account)}`)];

    printRows(rows, options);
    const drifted = rows.filter((r) => !r.ok).length;
    if (!options.json) {
      console.log(`\n${rows.length} account(s) checked; ${drifted} in drift`);
    }
    return drifted > 0 ? 1 : 0;
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
