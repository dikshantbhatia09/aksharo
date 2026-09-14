#!/usr/bin/env node
/**
 * Keep the dependency-audit exception register honest.
 *
 * `pnpm.auditConfig.ignoreGhsas` silences an advisory. Silencing without a
 * record is how a "temporary" acceptance becomes permanent: the finding stops
 * appearing, nobody is reminded, and two years later the reason is lost. This
 * makes every silenced advisory a documented decision with a named owner and a
 * date, and fails the build when one of those goes stale.
 *
 * Four failures, all of them loud:
 *
 *   1. pnpm ignores a GHSA that `security/audit-exceptions.json` does not list.
 *      Someone silenced a finding without writing down why.
 *   2. The register lists a GHSA that pnpm is not ignoring. Dead entry, or the
 *      ignore was removed and the register was not — either way it is drift.
 *   3. An exception is past its `expires` date. The decision was time-boxed and
 *      the time is up: re-argue it or fix the dependency.
 *   4. An exception has no real owner. "TODO" is not a person.
 *
 * Run: node scripts/check-audit-exceptions.mjs
 * CI:  the `security-audit` job, before the audit itself.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = join(REPO_ROOT, "security", "audit-exceptions.json");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");

/** A GitHub Security Advisory id. */
const GHSA_PATTERN = /^GHSA(-[0-9a-z]{4}){3}$/;

const problems = [];

function fail(message, file) {
  problems.push({ message, file });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not be read: ${error instanceof Error ? error.message : String(error)}`, path);
    return null;
  }
}

const register = readJson(REGISTER);
const packageJson = readJson(PACKAGE_JSON);
if (register === null || packageJson === null) {
  report();
  process.exit(1);
}

const exceptions = Array.isArray(register.exceptions) ? register.exceptions : [];
const ignored = packageJson.pnpm?.auditConfig?.ignoreGhsas ?? [];

// `--now` so a test can ask "what happens on the day this expires" without
// waiting for that day to arrive.
const nowArgument = process.argv.find((argument) => argument.startsWith("--now="));
const now = nowArgument === undefined ? new Date() : new Date(nowArgument.slice("--now=".length));

const documented = new Set();

for (const [index, exception] of exceptions.entries()) {
  const where = `exceptions[${String(index)}]`;
  const ghsa = exception.ghsa;

  if (typeof ghsa !== "string" || !GHSA_PATTERN.test(ghsa)) {
    fail(`${where}: "ghsa" must be a GHSA id, got ${JSON.stringify(ghsa)}`, REGISTER);
    continue;
  }
  documented.add(ghsa);

  if (typeof exception.owner !== "string" || /todo/i.test(exception.owner)) {
    fail(
      `${ghsa}: needs a real owner, not ${JSON.stringify(exception.owner)}. An exception ` +
        "nobody owns is an exception nobody will revisit.",
      REGISTER,
    );
  }

  if (typeof exception.reason !== "string" && !Array.isArray(exception.reason)) {
    fail(`${ghsa}: needs a "reason" saying why this cannot be reached at runtime.`, REGISTER);
  }

  const expires = new Date(exception.expires ?? "");
  if (Number.isNaN(expires.getTime())) {
    fail(`${ghsa}: "expires" must be a date (YYYY-MM-DD), got ${JSON.stringify(exception.expires)}`, REGISTER);
    continue;
  }
  if (expires < now) {
    fail(
      `${ghsa} (${String(exception.package)}) expired on ${expires.toISOString().slice(0, 10)}. ` +
        "Fix the dependency or re-accept it with a new expiry and a fresh justification.",
      REGISTER,
    );
  }
}

for (const ghsa of ignored) {
  if (!documented.has(ghsa)) {
    fail(
      `${String(ghsa)} is silenced by pnpm.auditConfig.ignoreGhsas but is not in the register. ` +
        "Add it with a reason, an owner and an expiry, or stop ignoring it.",
      PACKAGE_JSON,
    );
  }
}

for (const ghsa of documented) {
  if (!ignored.includes(ghsa)) {
    fail(
      `${ghsa} is in the register but pnpm is not ignoring it. Either it is fixed — ` +
        "remove the entry — or the ignore was dropped by mistake.",
      REGISTER,
    );
  }
}

report();
process.exit(problems.length === 0 ? 0 : 1);

function report() {
  for (const problem of problems) {
    // GitHub Actions renders this as an annotation on the file.
    console.error(`::error file=${problem.file}::${problem.message}`);
  }
  if (problems.length === 0) {
    console.log(
      `OK  ${String(documented.size)} accepted audit finding(s), all owned and in date.`,
    );
  }
}
