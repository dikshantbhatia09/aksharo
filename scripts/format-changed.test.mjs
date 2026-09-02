/**
 * Regression test for `format-changed.mjs`.
 *
 * The defect this guards against: `format-changed.mjs` disagreeing with
 * `pnpm format:check` about whether a file needs formatting. That happened for
 * real — a version that shelled out to `npx prettier` hit `EINVAL` spawning
 * `npx.cmd` on Windows with no shell, `status` came back `null`,
 * `status ?? 1` turned the crash into exit 1, and the script *looked* like it
 * was finding problems while Prettier had never run. Seven files went in
 * unformatted behind what should have been a red check. A false "clean" is
 * the same failure in the other direction, and just as silent.
 *
 * This builds a throwaway git repository — a fresh `git init` in the OS temp
 * directory, unrelated to this monorepo's own history, so the test controls
 * every commit and file exactly — with this workspace's real `node_modules`
 * (Prettier, `@montaj/config`) junctioned in, seeds it with deliberately
 * misformatted `.md`, `.mjs` and `.ts` files spread across the three sources
 * `format-changed.mjs` unions (committed against the merge base, staged but
 * uncommitted, and untracked), plus one already-clean file that must never be
 * flagged, and then:
 *
 *   1. drives the *actual on-disk* `format-changed.mjs` — including whatever
 *      is currently uncommitted in this checkout — with `--check`;
 *   2. cross-checks its per-file verdict against Prettier's own CLI
 *      (`prettier/bin/prettier.cjs`, invoked directly through `node` — the
 *      same fix this script itself relies on, for the same reason) run
 *      against each fixture file individually. This is the actual contract:
 *      not "matches what this test author expected", but "matches what
 *      Prettier itself says";
 *   3. asserts `--check` never writes;
 *   4. runs `--write` and asserts it fixes all three, then that a follow-up
 *      `--check` is clean.
 *
 *   node --test scripts/format-changed.test.mjs
 *   pnpm test:scripts
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "format-changed.mjs");

/**
 * The real monorepo root, used only to junction its installed `node_modules`
 * (Prettier, and the `@montaj/config` package Prettier is configured through)
 * into the throwaway fixture repo below. Nothing else about the real repo —
 * no file in it, no branch, no commit — is read, changed, or depended on.
 */
const repoRoot = resolve(
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim(),
);
const prettierBin = join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs");

/** Runs git in `cwd` and throws on failure — fixture setup should never fail silently. */
function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Runs `format-changed.mjs` (the real, current, on-disk copy) as a subprocess in `cwd`. */
function runFormatChanged(cwd, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
}

/** Runs Prettier's own CLI entry point directly through `node` — never the `.cmd` shim
 *  (see the docstring in `format-changed.mjs`: that shim is exactly what broke this
 *  before). Returns true if Prettier considers `file` already formatted. */
function prettierConsidersFormatted(cwd, file) {
  const result = spawnSync(process.execPath, [prettierBin, "--check", file], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0;
}

const FIXTURES = {
  // Missing a trailing newline; Prettier always adds exactly one. That alone
  // is enough to make this "unformatted" without depending on any markdown-
  // specific rewrite (this repo's config sets `proseWrap: "preserve"`, so
  // prose text itself is intentionally left alone).
  "notes.md": "#Notes\n\nSome text here.",
  // Cramped object/function spacing, no semicolons: unformatted under any
  // reasonable Prettier config, not just this repo's.
  "script.mjs": "const x={a:1,b:2};\nexport function add(a,b){\nreturn a+b\n}",
  "types.ts": "export function add(a:number,b:number):number{\nreturn a+b\n}",
  // Already exactly what Prettier would produce. Must never be reported as
  // needing formatting — the false-positive direction matters as much as the
  // false-negative one this defect was.
  "good.md": "# Good\n\nAlready fine.\n",
};

function setUpFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "format-changed-selftest-"));

  // Defense in depth alongside the explicit (never wildcard) `git add` calls
  // below: even if a future edit adds a broad `git add`, this keeps git from
  // ever walking into the junctioned `node_modules` and trying to commit the
  // real repo's dependency tree into this throwaway repo.
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "format-changed-fixture", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "prettier.config.mjs"),
    'export { default } from "@montaj/config/prettier";\n',
  );

  // The real, installed Prettier and `@montaj/config` — not reinstalled, not
  // reimplemented. `"junction"` avoids Windows' symlink-privilege requirement
  // and, per direct test, `rmdirSync` on the link later removes only the link.
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");

  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "selftest@example.invalid"]);
  git(root, ["config", "user.name", "format-changed self-test"]);
  git(root, ["config", "commit.gpgsign", "false"]); // local to this throwaway repo only
  git(root, ["add", ".gitignore", "package.json", "prettier.config.mjs"]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["checkout", "-b", "wp/test"]);

  // Committed on the branch: exercises the merge-base-with-`main` diff.
  writeFileSync(join(root, "types.ts"), FIXTURES["types.ts"]);
  git(root, ["add", "types.ts"]);
  git(root, ["commit", "-m", "add types"]);

  // Staged but not committed: exercises "uncommitted, staged or not".
  writeFileSync(join(root, "script.mjs"), FIXTURES["script.mjs"]);
  git(root, ["add", "script.mjs"]);

  // Untracked, including the already-clean control file.
  writeFileSync(join(root, "notes.md"), FIXTURES["notes.md"]);
  writeFileSync(join(root, "good.md"), FIXTURES["good.md"]);

  return root;
}

function tearDownFixtureRepo(root) {
  rmdirSync(join(root, "node_modules")); // unlinks the junction only, never its target
  rmSync(root, { recursive: true, force: true });
}

test("format-changed.mjs matches Prettier's own verdict end-to-end", async (t) => {
  const root = setUpFixtureRepo();
  try {
    await t.test("--check flags all three misformatted files, and not the clean one", () => {
      const result = runFormatChanged(root, ["--check"]);

      assert.equal(
        result.status,
        1,
        `expected exit 1 (needs formatting), got ${result.status}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stdout.includes("on 4 file(s) changed"),
        `expected all 4 fixture files to be candidates, got: ${result.stdout}`,
      );
      for (const name of ["types.ts", "script.mjs", "notes.md"]) {
        assert.ok(
          result.stderr.includes(name),
          `expected ${name} to be listed as needing formatting:\n${result.stderr}`,
        );
      }
      assert.ok(
        !result.stderr.includes("good.md"),
        `an already-formatted file must not be flagged:\n${result.stderr}`,
      );
    });

    await t.test(
      "the --check verdict for each file matches Prettier's own CLI, not just this test's expectations",
      () => {
        const expectFormatted = {
          "types.ts": false,
          "script.mjs": false,
          "notes.md": false,
          "good.md": true,
        };
        for (const [name, shouldBeFormatted] of Object.entries(expectFormatted)) {
          assert.equal(
            prettierConsidersFormatted(root, name),
            shouldBeFormatted,
            `oracle mismatch for ${name}`,
          );
        }
      },
    );

    await t.test("--check never writes", () => {
      const before = readFileSync(join(root, "notes.md"), "utf8");
      runFormatChanged(root, ["--check"]);
      const after = readFileSync(join(root, "notes.md"), "utf8");
      assert.equal(after, before, "--check must leave files untouched");
    });

    await t.test("--write fixes all three, and a follow-up --check is clean", () => {
      const write = runFormatChanged(root, []);
      assert.equal(
        write.status,
        0,
        `expected exit 0, got ${write.status}\nstderr: ${write.stderr}`,
      );
      assert.ok(
        write.stdout.includes("rewrote 3 file"),
        `expected 3 rewrites, got: ${write.stdout}`,
      );

      // Exact byte-for-byte match against Prettier's own output for the
      // simplest fixture — not merely "something changed".
      assert.equal(readFileSync(join(root, "notes.md"), "utf8"), "#Notes\n\nSome text here.\n");
      assert.equal(
        readFileSync(join(root, "script.mjs"), "utf8"),
        "const x = { a: 1, b: 2 };\nexport function add(a, b) {\n  return a + b;\n}\n",
      );
      assert.equal(
        readFileSync(join(root, "types.ts"), "utf8"),
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      );

      const recheck = runFormatChanged(root, ["--check"]);
      assert.equal(
        recheck.status,
        0,
        `expected a clean check after --write, got ${recheck.status}\nstdout: ${recheck.stdout}\nstderr: ${recheck.stderr}`,
      );
      assert.ok(recheck.stdout.includes("all clean"));
    });
  } finally {
    tearDownFixtureRepo(root);
  }
});

/**
 * `format-changed.mjs` resolves each file's Prettier options with
 * `{ editorconfig: true }`. That is not the default — this same Prettier
 * build treats an *omitted* `editorconfig` option identically to `false` —
 * and the CLI (`prettier --check`, what `pnpm format:check` runs) always
 * requests `editorconfig: true` unless `--no-editorconfig` is passed, which
 * nothing here does. Get this wrong and a file can be "clean" to the script
 * while a nearby `.editorconfig` makes the CLI disagree.
 *
 * This repo's own `.editorconfig` and `prettier.config.mjs` happen to agree
 * on every property `.editorconfig` can set (tabWidth/printWidth/useTabs), so
 * that particular regression would pass the first test above even if
 * reintroduced — the disagreement needs a config gap to become visible. This
 * fixture supplies one deliberately: a minimal Prettier config with no
 * `printWidth` of its own, plus an `.editorconfig` that sets one far
 * narrower than Prettier's built-in default (80), on a line that is clean
 * under the default but not under the narrower one.
 */
function setUpEditorconfigFixture() {
  const root = mkdtempSync(join(tmpdir(), "format-changed-selftest-ec-"));

  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "format-changed-ec-fixture", private: true }, null, 2)}\n`,
  );
  // Deliberately minimal: no printWidth/tabWidth of its own, so an
  // `.editorconfig` value has room to be the thing that decides the verdict.
  writeFileSync(join(root, "prettier.config.mjs"), "export default {};\n");
  writeFileSync(join(root, ".editorconfig"), "root = true\n\n[*.ts]\nmax_line_length = 20\n");

  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");

  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "selftest@example.invalid"]);
  git(root, ["config", "user.name", "format-changed self-test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", ".gitignore", "package.json", "prettier.config.mjs", ".editorconfig"]);
  git(root, ["commit", "-m", "init"]);

  // 54 characters: comfortably under Prettier's default printWidth (80), so
  // this is clean under the base config alone — but over the 20 that
  // `.editorconfig` sets for *.ts, so it is unformatted once that is honoured.
  writeFileSync(join(root, "narrow.ts"), "export const value = compute(alphaValue, betaValue);\n");

  return root;
}

test("format-changed.mjs resolves .editorconfig the same way the Prettier CLI does", async (t) => {
  const root = setUpEditorconfigFixture();
  try {
    await t.test(
      "the oracle itself is sensitive to this .editorconfig (validates the fixture)",
      () => {
        assert.equal(
          prettierConsidersFormatted(root, "narrow.ts"),
          false,
          "fixture is invalid: Prettier's own CLI must flag narrow.ts given max_line_length=20",
        );
      },
    );

    await t.test("--check agrees: narrow.ts needs formatting", () => {
      const result = runFormatChanged(root, ["--check"]);
      assert.equal(
        result.status,
        1,
        `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stderr.includes("narrow.ts"),
        `expected narrow.ts to be listed:\n${result.stderr}`,
      );
    });
  } finally {
    tearDownFixtureRepo(root);
  }
});
