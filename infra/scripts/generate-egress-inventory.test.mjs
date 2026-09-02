/**
 * CLI-level regression test for `generate-egress-inventory.mjs` (X08 scope
 * item 1). Runs the real, on-disk script as a subprocess against a throwaway
 * git repository — the same pattern `scripts/format-changed.test.mjs` uses —
 * so the test exercises `git rev-parse --show-toplevel` and file I/O exactly
 * as CI will, not a mocked version of them.
 *
 *   node --test infra/scripts/generate-egress-inventory.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "generate-egress-inventory.mjs");
const egressHostsPath = join(here, "egress-hosts.mjs");

/**
 * The real monorepo root, used only to junction its installed `node_modules`
 * (for Prettier, which the script formats its output through) into the
 * throwaway fixture repo below — the same technique
 * `scripts/format-changed.test.mjs` uses, for the same reason: the fixture
 * repo has no `node_modules` of its own, and the script must resolve the
 * workspace's real, pinned Prettier rather than fail to find one at all.
 */
const repoRoot = resolve(
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim(),
);

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function run(cwd, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
}

/** A throwaway repo with the real egress-hosts.mjs copied in, so the CLI resolves it by relative import. */
function setUpRepo() {
  const root = mkdtempSync(join(tmpdir(), "egress-inventory-cli-test-"));
  mkdirSync(join(root, "infra", "scripts"), { recursive: true });
  mkdirSync(join(root, "infra", "policies"), { recursive: true });
  writeFileSync(join(root, "infra", "scripts", "egress-hosts.mjs"), readFileSync(egressHostsPath));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "egress-inventory-fixture", private: true }, null, 2)}\n`,
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");

  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "selftest@example.invalid"]);
  git(root, ["config", "user.name", "egress-inventory self-test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git(root, ["add", ".gitignore", "package.json", "infra"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

function tearDown(root) {
  rmdirSync(join(root, "node_modules")); // unlinks the junction only, never its target
  rmSync(root, { recursive: true, force: true });
}

test("generate-egress-inventory writes a clean inventory when every code host is known", () => {
  const root = setUpRepo();
  try {
    mkdirSync(join(root, "apps", "api", "src", "auth"), { recursive: true });
    writeFileSync(
      join(root, "apps", "api", "src", "auth", "google-oauth.provider.ts"),
      'export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";\n',
    );

    const result = run(root, []);
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`,
    );

    const written = JSON.parse(
      readFileSync(join(root, "infra", "policies", "egress-inventory.json"), "utf8"),
    );
    assert.ok(written.entries.some((e) => e.host === "oauth2.googleapis.com"));
  } finally {
    tearDown(root);
  }
});

test("generate-egress-inventory --check fails (and writes nothing) on a new, unrecognised host", () => {
  const root = setUpRepo();
  try {
    mkdirSync(join(root, "apps", "worker-ai", "worker_ai", "providers"), { recursive: true });
    writeFileSync(
      join(root, "apps", "worker-ai", "worker_ai", "providers", "evil.py"),
      'EVIL_DEFAULT_BASE_URL = "https://api.evil-exfil.test"\n',
    );

    const result = run(root, ["--check"]);
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}\nstdout: ${result.stdout}`,
    );
    assert.ok(result.stderr.includes("api.evil-exfil.test"));
    assert.ok(
      result.stderr.includes("no metadata entry"),
      `expected the missing-metadata message, got: ${result.stderr}`,
    );
  } finally {
    tearDown(root);
  }
});

test("generate-egress-inventory --check fails when the committed file is stale", () => {
  const root = setUpRepo();
  try {
    // A stale (empty-entries) inventory already committed...
    writeFileSync(join(root, "infra", "policies", "egress-inventory.json"), '{"entries":[]}\n');

    // ...but the code now has a known host the file does not reflect.
    mkdirSync(join(root, "apps", "api", "src", "auth"), { recursive: true });
    writeFileSync(
      join(root, "apps", "api", "src", "auth", "google-oauth.provider.ts"),
      'export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";\n',
    );

    const result = run(root, ["--check"]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.ok(result.stderr.includes("out of date"));
  } finally {
    tearDown(root);
  }
});

test("generate-egress-inventory --check passes once the file matches a fresh generation", () => {
  const root = setUpRepo();
  try {
    mkdirSync(join(root, "apps", "api", "src", "auth"), { recursive: true });
    writeFileSync(
      join(root, "apps", "api", "src", "auth", "google-oauth.provider.ts"),
      'export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";\n',
    );

    const write = run(root, []);
    assert.equal(write.status, 0, `expected exit 0, got ${write.status}\nstderr: ${write.stderr}`);

    const check = run(root, ["--check"]);
    assert.equal(
      check.status,
      0,
      `expected --check to pass, got ${check.status}\nstderr: ${check.stderr}`,
    );
  } finally {
    tearDown(root);
  }
});
