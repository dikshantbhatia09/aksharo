/**
 * Regression tests for `validate-chart-local.mjs` (X08 scope item 3): the
 * local, dependency-free stand-in for `helm lint`/`helm template` on a host
 * with no Helm binary. Each test builds a minimal throwaway chart under a temp
 * directory, runs the real on-disk script against it (cwd set to the fixture
 * root, the same way the script is meant to be invoked from a repo root), and
 * checks the exit code and message.
 *
 *   node --test infra/scripts/validate-chart-local.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "validate-chart-local.mjs");

const GOOD_CHART_YAML = [
  "apiVersion: v2",
  "name: fixture",
  "version: 0.1.0",
  'appVersion: "0.1.0"',
  "",
].join("\n");

const GOOD_VALUES_YAML = [
  "networkPolicy:",
  "  fqdn:",
  "    mode: off",
  "  providerAllowlist:",
  "    - host: api.example.com",
  "      reason: test vendor",
  "  providerAllowlistSuffixes:",
  "    - host: .example.net",
  "      reason: test suffix vendor",
  "components:",
  "  worker:",
  "    enabled: true",
  "    kind: worker",
  "    repository: montaj/worker",
  "    network:",
  "      allowProviderEgress: true",
  "",
].join("\n");

const GOOD_TEMPLATE = ["{{- if .Values.networkPolicy.enabled }}", "kind: NetworkPolicy", "{{- end }}", ""].join(
  "\n",
);

function makeChart({ chartYaml = GOOD_CHART_YAML, values = GOOD_VALUES_YAML, template = GOOD_TEMPLATE } = {}) {
  const root = mkdtempSync(join(tmpdir(), "validate-chart-local-test-"));
  const chartDir = join(root, "infra", "k8s", "montaj");
  mkdirSync(join(chartDir, "templates"), { recursive: true });
  writeFileSync(join(chartDir, "Chart.yaml"), chartYaml);
  writeFileSync(join(chartDir, "values.yaml"), values);
  writeFileSync(join(chartDir, "values-staging.yaml"), "networkPolicy:\n  fqdn:\n    mode: off\n");
  writeFileSync(join(chartDir, "values-prod.yaml"), "networkPolicy:\n  fqdn:\n    mode: off\n");
  writeFileSync(join(chartDir, "templates", "networkpolicy.yaml"), template);
  return root;
}

function run(cwd) {
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

test("validate-chart-local passes on a well-formed minimal chart", () => {
  const root = makeChart();
  try {
    const result = run(root);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("all checks passed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails when Chart.yaml is missing a required field", () => {
  const root = makeChart({ chartYaml: "apiVersion: v2\nname: fixture\n" });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("version"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails on a providerAllowlist entry missing a reason", () => {
  const root = makeChart({
    values: [
      "networkPolicy:",
      "  fqdn:",
      "    mode: off",
      "  providerAllowlist:",
      "    - host: api.example.com",
      "components: {}",
      "",
    ].join("\n"),
  });
  try {
    const result = run(root);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout: ${result.stdout}`);
    assert.ok(result.stderr.includes("missing a 'reason'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails on a providerAllowlistSuffixes host not starting with '.'", () => {
  const root = makeChart({
    values: [
      "networkPolicy:",
      "  fqdn:",
      "    mode: off",
      "  providerAllowlistSuffixes:",
      "    - host: example.net",
      "      reason: missing leading dot",
      "components: {}",
      "",
    ].join("\n"),
  });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("must have a host starting with '.'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails enforce mode with allowProviderEgress but an empty allow-list", () => {
  const root = makeChart({
    values: [
      "networkPolicy:",
      "  fqdn:",
      "    mode: off",
      "components:",
      "  worker:",
      "    enabled: true",
      "    kind: worker",
      "    repository: montaj/worker",
      "    network:",
      "      allowProviderEgress: true",
      "",
    ].join("\n"),
  });
  try {
    const result = run(root);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout: ${result.stdout}`);
    assert.ok(result.stderr.includes("would be dropped from all provider egress"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails on an unbalanced {{- if }} in a template", () => {
  const root = makeChart({ template: "{{- if .Values.networkPolicy.enabled }}\nkind: NetworkPolicy\n" });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("unbalanced Helm template actions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails when an enabled component is missing its network block", () => {
  const root = makeChart({
    values: [
      "networkPolicy:",
      "  fqdn:",
      "    mode: off",
      "components:",
      "  worker:",
      "    enabled: true",
      "    kind: worker",
      "    repository: montaj/worker",
      "",
    ].join("\n"),
  });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("missing a 'network' block"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local ignores a disabled component missing kind/repository/network", () => {
  const root = makeChart({
    values: [
      "networkPolicy:",
      "  fqdn:",
      "    mode: off",
      "components:",
      "  worker:",
      "    enabled: false",
      "",
    ].join("\n"),
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validate-chart-local fails on an invalid networkPolicy.fqdn.mode in an env values file", () => {
  const root = makeChart();
  try {
    writeFileSync(
      join(root, "infra", "k8s", "montaj", "values-prod.yaml"),
      "networkPolicy:\n  fqdn:\n    mode: sometimes\n",
    );
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("values-prod.yaml"));
    assert.ok(result.stderr.includes("sometimes"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
