/**
 * Unit tests for `egress-hosts.mjs` — the scan-and-cross-reference logic
 * behind `generate-egress-inventory.mjs` (X08 scope item 1, item 5).
 *
 * `node --test infra/scripts/egress-hosts.test.mjs`
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildInventory, findMetadata, scanCodeHosts, VENDOR_METADATA } from "./egress-hosts.mjs";

function makeFixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "egress-hosts-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("scanCodeHosts finds a Python *_DEFAULT_BASE_URL constant", async () => {
  const root = makeFixtureTree({
    "apps/worker-ai/worker_ai/providers/sarvam.py": [
      "# some header",
      'SARVAM_DEFAULT_BASE_URL = "https://api.sarvam.ai"',
      "",
    ].join("\n"),
  });
  try {
    const hosts = await scanCodeHosts(root, ["apps/worker-ai/worker_ai"]);
    assert.deepEqual(
      hosts.map((h) => h.host),
      ["api.sarvam.ai"],
    );
    assert.equal(hosts[0].occurrences.length, 1);
    assert.equal(hosts[0].occurrences[0].line, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanCodeHosts finds a TypeScript exported *_ENDPOINT constant", async () => {
  const root = makeFixtureTree({
    "apps/api/src/auth/google-oauth.provider.ts": [
      'export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";',
    ].join("\n"),
  });
  try {
    const hosts = await scanCodeHosts(root, ["apps/api/src"]);
    assert.deepEqual(
      hosts.map((h) => h.host),
      ["oauth2.googleapis.com"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanCodeHosts ignores test files", async () => {
  const root = makeFixtureTree({
    "apps/api/src/webhooks/webhook-doc-snippets.test.ts":
      'const EXAMPLE_URL = "https://api.aksharo.example/v1/projects";',
  });
  try {
    const hosts = await scanCodeHosts(root, ["apps/api/src"]);
    assert.deepEqual(hosts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanCodeHosts de-duplicates the same host across files and collects every occurrence", async () => {
  const root = makeFixtureTree({
    "apps/worker-ai/worker_ai/providers/sarvam.py":
      'SARVAM_DEFAULT_BASE_URL = "https://api.sarvam.ai"\n',
    "apps/worker-ai/worker_ai/translate/providers/sarvam_mayura.py":
      'SARVAM_TRANSLATE_DEFAULT_BASE_URL = "https://api.sarvam.ai"\n',
  });
  try {
    const hosts = await scanCodeHosts(root, ["apps/worker-ai/worker_ai"]);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host, "api.sarvam.ai");
    assert.equal(hosts[0].occurrences.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findMetadata matches an exact host and the longest suffix", () => {
  const exact = findMetadata("api.sarvam.ai");
  assert.equal(exact?.owner, "platform-ai");

  const suffix = findMetadata("montaj-derived.r2.cloudflarestorage.com");
  assert.equal(suffix?.matchType, "suffix");
  assert.equal(suffix?.host, ".r2.cloudflarestorage.com");

  assert.equal(findMetadata("evil.example"), null);
});

test("every VENDOR_METADATA entry has a non-empty owner, purpose and workloads list", () => {
  for (const entry of VENDOR_METADATA) {
    assert.ok(entry.host.length > 0, `${JSON.stringify(entry)} missing host`);
    assert.ok(["exact", "suffix"].includes(entry.matchType), `${entry.host}: bad matchType`);
    assert.ok(entry.owner.length > 0, `${entry.host}: missing owner`);
    assert.ok(entry.purpose.length > 0, `${entry.host}: missing purpose`);
    assert.ok(
      Array.isArray(entry.workloads) && entry.workloads.length > 0,
      `${entry.host}: missing workloads`,
    );
    assert.ok(["code", "declared"].includes(entry.source), `${entry.host}: bad source`);
  }
});

test("buildInventory resolves a known code host to its metadata entry", async () => {
  const root = makeFixtureTree({
    "apps/api/src/auth/google-oauth.provider.ts":
      'export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";',
  });
  try {
    const { entries, unknown } = await buildInventory(root, ["apps/api/src"]);
    assert.deepEqual(unknown, []);
    const entry = entries.find((e) => e.host === "oauth2.googleapis.com");
    assert.ok(entry, "expected oauth2.googleapis.com in the inventory");
    assert.equal(entry.source, "code");
    assert.equal(entry.discoveredIn.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildInventory includes declared hosts (R2, Sentry, RunPod, AWS) with no code occurrence", async () => {
  const root = makeFixtureTree({ "apps/api/src/.keep": "" });
  try {
    const { entries } = await buildInventory(root, ["apps/api/src"]);
    const r2 = entries.find((e) => e.host === ".r2.cloudflarestorage.com");
    assert.ok(r2, "expected the R2 suffix entry");
    assert.equal(r2.source, "declared");
    assert.deepEqual(r2.discoveredIn, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildInventory fails a new, unrecognised host instead of silently allowing it", async () => {
  const root = makeFixtureTree({
    "apps/worker-ai/worker_ai/providers/evil.py":
      'EVIL_DEFAULT_BASE_URL = "https://api.evil-exfil.test"\n',
  });
  try {
    const { entries, unknown } = await buildInventory(root, ["apps/worker-ai/worker_ai"]);
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].host, "api.evil-exfil.test");
    assert.ok(
      !entries.some((e) => e.host === "api.evil-exfil.test"),
      "an unknown host must never be written into the inventory",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
