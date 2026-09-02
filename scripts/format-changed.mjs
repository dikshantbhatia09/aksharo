/**
 * Prettier, on the files this branch actually touched.
 *
 * `pnpm format` rewrites the whole repository. In a monorepo where several
 * agents work in parallel worktrees that is not a convenience, it is a way to
 * put a hundred unrelated files into a diff and then have to unpick them by
 * hand: every work package so far has had to revert a `pnpm format` run over
 * `apps/api`, `docs/` or `tools/` that it never meant to touch.
 *
 * This formats exactly two sets, unioned and de-duplicated:
 *
 *   1. what differs from the merge base with `main` (`git diff --name-only main...HEAD`),
 *      which is this branch's work however many commits it took;
 *   2. what is uncommitted right now, staged or not, including new files.
 *
 * Deleted paths are dropped, and so is anything Prettier has no parser for.
 *
 *   node scripts/format-changed.mjs          # rewrite
 *   node scripts/format-changed.mjs --check  # fail if anything is unformatted
 *
 * `--base <ref>` compares against something other than `main`, which is what a
 * branch cut from a release line wants.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Extensions the repository's Prettier config has a parser for. */
const FORMATTABLE = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "yml",
  "yaml",
  "css",
]);

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const base = option("base", "main");

// `main...HEAD` is the merge base, not the tip: a branch that merged `main` in
// (which the integration rule requires) must not then own every file that merge
// brought with it.
const committed = git(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`]);
const uncommitted = git(["diff", "--name-only", "--diff-filter=d", "HEAD"]);
const untracked = git(["ls-files", "--others", "--exclude-standard"]);

const files = [...new Set([...committed.split("\n"), ...uncommitted.split("\n"), ...untracked.split("\n")])]
  .map((line) => line.trim())
  .filter((line) => line !== "")
  .filter((line) => FORMATTABLE.has(line.split(".").pop()?.toLowerCase() ?? ""))
  .filter((line) => existsSync(line));

if (files.length === 0) {
  process.stdout.write(`format:changed — nothing to format against ${base}\n`);
  process.exit(0);
}

const mode = flag("check") ? "--check" : "--write";
process.stdout.write(
  `format:changed — prettier ${mode} on ${String(files.length)} file(s) changed against ${base}\n`,
);

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prettier", mode, "--ignore-unknown", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
