/**
 * Prettier, on the files this branch actually touched.
 *
 * `pnpm format` rewrites every file in the repository. Several work packages run
 * at once, each in its own worktree, so a repo-wide rewrite drags dozens of
 * files nobody touched into the diff — and every one has then had to be reverted
 * by hand before the commit. This formats exactly two sets, unioned and
 * de-duplicated:
 *
 *   1. what differs from the merge base with `main`
 *      (`git diff --name-only main...HEAD`), which is this branch's work however
 *      many commits it took and however many times `main` was merged in;
 *   2. what is uncommitted right now, staged or not, including new files.
 *
 *   node scripts/format-changed.mjs          # rewrite
 *   node scripts/format-changed.mjs --check  # fail if anything is unformatted
 *   node scripts/format-changed.mjs --base release/1.2
 *
 * **The verdict must match `pnpm format:check` exactly**, or the script is worse
 * than useless: it says "clean" and the repo's own gate then says otherwise.
 * Three things keep the two in step, and all three are regression-tested in
 * `format-changed.test.mjs`:
 *
 * - **Prettier is called through its Node API, never through a child process.**
 *   The first version shelled out to `npx prettier`, and on Windows
 *   `spawnSync("npx.cmd", …)` fails with `EINVAL` — Node refuses to spawn a
 *   `.cmd` without a shell. `status` came back `null`, `status ?? 1` turned that
 *   into exit 1, and the script looked like it was finding problems while
 *   Prettier had never run at all. Seven files went in unformatted behind a
 *   green check. The API has no shell, no argument-length ceiling and no
 *   platform-specific launcher.
 * - **Everything resolves from the repo root**, whatever the cwd: the git
 *   queries, `.prettierignore`, `prettier.config.mjs` and the Prettier package
 *   itself (so it is the pinned workspace copy, not whatever `npx` would fetch).
 * - **"Could not run" is never reported as "found issues."** A file Prettier
 *   cannot parse, or a set-up failure, exits **2** with the reason. Exit 1 means
 *   one thing only: files need formatting.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The extension set of the repo-wide glob in `package.json`.
 *
 * It is here to pick files out of `git diff`, which lists everything including
 * `.png` and `.lock`; it is **not** a second opinion about what Prettier can
 * handle. Anything in this set that Prettier then declines to parse is an error,
 * not a silent skip.
 */
const REPO_GLOB_EXTENSIONS = new Set([
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

/** Exit codes. `1` is "needs formatting" and nothing else. */
const EXIT_OK = 0;
const EXIT_NEEDS_FORMATTING = 1;
const EXIT_COULD_NOT_RUN = 2;

function fail(message) {
  process.stderr.write(`format:changed — ${message}\n`);
  process.exit(EXIT_COULD_NOT_RUN);
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** Runs git at the repo root; a failure is empty output, not a crash. */
function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/** The repository root, so the answer does not depend on where this was run. */
function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

const root = repoRoot();
if (root === "") fail("not inside a git repository");

// Everything below runs as if from the root: Prettier resolves its config and
// its ignore files by walking up from each file, and a relative cwd would make
// the same file get different answers from different directories.
process.chdir(root);

/**
 * Prettier, resolved from the repo root.
 *
 * `createRequire(...).resolve` pins it to the workspace's own installed copy —
 * the same one `pnpm format:check` runs — rather than whatever a global install
 * or an `npx` download might supply.
 */
const require = createRequire(pathToFileURL(join(root, "package.json")));
let prettier;
try {
  // `require.resolve` lands on the CommonJS entry, so the namespace an `import()`
  // hands back keeps the real exports under `.default`.
  const loaded = await import(pathToFileURL(require.resolve("prettier", { paths: [root] })).href);
  prettier = typeof loaded.getFileInfo === "function" ? loaded : loaded.default;
  if (typeof prettier?.getFileInfo !== "function") {
    throw new Error("the resolved module does not look like prettier");
  }
} catch (error) {
  fail(`could not load prettier from ${root}: ${error instanceof Error ? error.message : error}`);
}

/** The ignore files Prettier's CLI reads by default, if they exist. */
const ignorePath = [".gitignore", ".prettierignore"]
  .map((name) => join(root, name))
  .filter((path) => existsSync(path));

const base = option("base", "main");
const check = flag("check");

// `main...HEAD` is the merge base, not the tip: a branch that merged `main` in —
// which the integration rule requires — must not then own every file that merge
// brought with it.
const sources = [
  git(root, ["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`]),
  git(root, ["diff", "--name-only", "--diff-filter=d", "HEAD"]),
  git(root, ["ls-files", "--others", "--exclude-standard"]),
];

const skipped = [];
const candidates = [...new Set(sources.join("\n").split("\n"))]
  .map((line) => line.trim())
  .filter((line) => line !== "")
  .map((line) => (isAbsolute(line) ? line : resolve(root, line)))
  .filter((path) => existsSync(path))
  .filter((path) => {
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    if (REPO_GLOB_EXTENSIONS.has(extension)) return true;
    // Not in the repo-wide glob either, so `format:check` would not see it and
    // neither should this. Silent by design, and only here.
    return false;
  })
  .sort();

const unformatted = [];
const written = [];

for (const path of candidates) {
  const shown = relative(root, path).replace(/\\/g, "/");
  let info;
  try {
    info = await prettier.getFileInfo(path, { ignorePath, resolveConfig: false });
  } catch (error) {
    fail(`could not inspect ${shown}: ${error instanceof Error ? error.message : error}`);
  }
  // `.prettierignore` and `.gitignore` are the CLI's own defaults; honouring the
  // same files is most of what keeps the two verdicts equal.
  if (info.ignored) continue;
  if (info.inferredParser === null || info.inferredParser === undefined) {
    // In the repo glob but unparseable: `format:check` would fail on it, so this
    // is reported rather than skipped.
    skipped.push(shown);
    continue;
  }

  let source;
  let formatted;
  try {
    source = await readFile(path, "utf8");
    // `prettier --check` always resolves with editorconfig on (it is the CLI's
    // default; only `--no-editorconfig` turns it off, and nothing here passes
    // that). Passing `false` — or omitting the option, which this build treats
    // the same as `false` — silently stops matching the CLI the moment a file's
    // directory picks up an `.editorconfig` value prettier.config.mjs does not
    // already pin for every file: today's root `.editorconfig` and
    // `prettier.config.mjs` happen to agree on tabWidth/printWidth, so the gap
    // does not currently misformat anything, but that is luck, not a guarantee.
    const options = await prettier.resolveConfig(path, { editorconfig: true });
    formatted = await prettier.format(source, { ...options, filepath: path });
  } catch (error) {
    fail(`could not format ${shown}: ${error instanceof Error ? error.message : error}`);
  }

  if (formatted === source) continue;
  if (check) {
    unformatted.push(shown);
  } else {
    await writeFile(path, formatted, "utf8");
    written.push(shown);
  }
}

const mode = check ? "--check" : "--write";
process.stdout.write(
  `format:changed — prettier ${mode} on ${String(candidates.length)} file(s) changed against ${base}\n`,
);

if (skipped.length > 0) {
  process.stderr.write(
    `format:changed — prettier has no parser for ${skipped.length} file(s) the repo glob covers:\n` +
      `${skipped.map((path) => `  ${path}\n`).join("")}`,
  );
  process.exit(EXIT_COULD_NOT_RUN);
}

if (check) {
  if (unformatted.length === 0) {
    process.stdout.write("format:changed — all clean\n");
    process.exit(EXIT_OK);
  }
  process.stderr.write(
    `format:changed — ${unformatted.length} file(s) need formatting:\n` +
      `${unformatted.map((path) => `  ${path}\n`).join("")}` +
      "Run: pnpm format:changed\n",
  );
  process.exit(EXIT_NEEDS_FORMATTING);
}

process.stdout.write(
  written.length === 0
    ? "format:changed — nothing to rewrite\n"
    : `format:changed — rewrote ${written.length} file(s):\n${written.map((path) => `  ${path}\n`).join("")}`,
);
process.exit(EXIT_OK);
