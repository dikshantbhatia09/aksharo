#!/usr/bin/env node
/**
 * Remove build artefacts the turbo `clean` tasks do not own: the turbo cache and
 * every `node_modules` in the workspace. Dependencies are NOT reinstalled — run
 * `pnpm install` afterwards.
 *
 *   pnpm clean            turbo clean tasks, then this
 *   node scripts/clean.mjs --deps   also delete node_modules
 */
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_GLOBS = ["apps", "packages", "plugins", "engine"];
const withDeps = process.argv.includes("--deps");

/** @param {string} target */
function remove(target) {
  rmSync(target, { recursive: true, force: true });
}

/** @param {string} dir */
function workspaceDirs(dir) {
  try {
    return readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ROOT, dir, entry.name));
  } catch {
    return [];
  }
}

remove(join(ROOT, ".turbo"));
if (withDeps) remove(join(ROOT, "node_modules"));

for (const group of WORKSPACE_GLOBS) {
  for (const pkg of workspaceDirs(group)) {
    remove(join(pkg, ".turbo"));
    if (withDeps) remove(join(pkg, "node_modules"));
  }
}

process.stdout.write(
  withDeps
    ? "cleaned turbo caches and node_modules — run `pnpm install`\n"
    : "cleaned turbo caches (pass --deps to remove node_modules too)\n",
);
