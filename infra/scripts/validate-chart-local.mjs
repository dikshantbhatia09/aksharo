#!/usr/bin/env node
/**
 * Local stand-in for `helm lint` / `helm template` (X08 scope item 3).
 *
 * This host has no `helm` binary (per the work-package host guard: a shared
 * machine running many agents, nothing vendored — no Helm downloaded, no new
 * root dependency added just to parse YAML generically). `.github/workflows/
 * infra.yml` installs the real Helm 3 and kubeconform and runs the genuine
 * `helm lint` / `helm template` / `kubeconform` pipeline on every push — that
 * is the actual gate. This script does not reimplement Helm's template engine
 * or a general YAML parser; it is a fast, dependency-free, line-oriented scan
 * of exactly the constructs this chart's `values.yaml` uses, tailored to catch
 * the mistakes a values-only change is likely to introduce.
 *
 * What it checks, using nothing but `node:fs`/`node:path`:
 *
 *   1. `Chart.yaml` has the top-level scalar fields Helm requires
 *      (`apiVersion`, `name`, `version`, `appVersion`) — a flat `key: value`
 *      scan, since Chart.yaml has no nesting deep enough to need more.
 *   2. `values.yaml`'s `networkPolicy.providerAllowlist` and
 *      `providerAllowlistSuffixes` blocks: every entry has both a `host` and
 *      a `reason`, and every suffix entry's host starts with `.`.
 *   3. `values.yaml`'s `components.<name>` blocks: every enabled component has
 *      `kind`, `repository` and a nested `network:` block; a component with
 *      `network.allowProviderEgress: true` is cross-checked against the
 *      allow-list from (2) — `networkPolicy.fqdn.mode: enforce` with an empty
 *      allow-list would silently drop that component from all provider
 *      egress, so this fails for all three modes if the allow-list is empty
 *      and a component needs it, since off/audit/enforce differ only in
 *      *when* the allow-list is enforced, not in whether one exists.
 *   4. Every `templates/*.yaml` and `templates/_helpers.tpl` file has balanced
 *      `{{- if/range/with/define }}` / `{{- end }}` counts — the class of
 *      Helm syntax error ("template: ...: unexpected EOF") a plain diff review
 *      misses easily and that would otherwise only surface when CI (or a real
 *      cluster) runs Helm.
 *
 * `values-staging.yaml` and `values-prod.yaml` are checked only for the
 * presence of a valid `networkPolicy.fqdn.mode` line (or none, since `off` is
 * the base chart's default) — neither overrides `providerAllowlist` or a
 * component's `network` block, so (2) and (3) above are meaningful against
 * `values.yaml` alone; a future values file that does override either should
 * extend this script's scan rather than assume it is covered.
 *
 * This is a values-shape gate, not a schema validator for Kubernetes objects —
 * kubeconform in CI is what actually validates the rendered manifests, and
 * only a real `helm lint`/`helm template` can do that at all.
 *
 *   node infra/scripts/validate-chart-local.mjs
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const CHART_DIR = "infra/k8s/montaj";
const FQDN_MODES = ["off", "audit", "enforce"];

let failed = false;
function fail(message) {
  failed = true;
  process.stderr.write(`validate-chart-local — ${message}\n`);
}
function ok(message) {
  process.stdout.write(`validate-chart-local — OK: ${message}\n`);
}

/** Strips a trailing `# comment` that is not inside quotes. Good enough for this chart's style: no `#` appears inside a quoted value here. */
function stripComment(line) {
  const hashIndex = line.indexOf("#");
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

async function checkChartYaml(root) {
  const path = join(root, CHART_DIR, "Chart.yaml");
  const text = await readFile(path, "utf8");
  const fields = {};
  for (const raw of text.split("\n")) {
    const line = stripComment(raw);
    const match = /^([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  const missing = ["apiVersion", "name", "version", "appVersion"].filter((f) => !fields[f]);
  for (const field of missing) fail(`Chart.yaml is missing required field '${field}'`);
  if (missing.length === 0) ok("Chart.yaml has required top-level fields");
}

/**
 * Scans a `key:` block introduced at `blockIndent` for `- field: value` list
 * entries, each optionally followed by more `field: value` lines at the same
 * indent as `host`/`reason` would sit. Returns entries as plain objects.
 * Stops at the first line whose indent is <= blockIndent (dedent out of the
 * block) or at end of file.
 */
function scanListOfMaps(lines, startIndex, blockIndent) {
  const entries = [];
  let current = null;
  let itemIndent = null;
  let i = startIndex;
  for (; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    const line = stripComment(raw);
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent <= blockIndent) break;

    const itemMatch = /^(\s*)-\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(.*?)\s*$/.exec(line);
    const fieldMatch = /^(\s*)([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(.*?)\s*$/.exec(line);

    if (itemMatch) {
      if (current) entries.push(current);
      current = { [itemMatch[2]]: unquote(itemMatch[3]) };
      itemIndent = itemMatch[1].length + 2; // continuation fields align past "- "
    } else if (fieldMatch && current && indent >= itemIndent) {
      current[fieldMatch[2]] = unquote(fieldMatch[3]);
    } else {
      break; // something we don't recognise inside the block: stop rather than misparse
    }
  }
  if (current) entries.push(current);
  return { entries, nextIndex: i };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Finds a top-level `key:` line (no indent) and returns its line index, or -1. */
function findTopLevelKey(lines, key) {
  return lines.findIndex((raw) => new RegExp(`^${key}\\s*:\\s*$`).test(stripComment(raw)));
}

/** Finds a nested `key:` line at exactly `indent` spaces, searching from `fromIndex`, stopping at `stopIndent` dedent. */
function findNestedKey(lines, fromIndex, indent, key, stopIndent) {
  for (let i = fromIndex; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    const line = stripComment(raw);
    if (line.trim() === "") continue;
    const lineIndent = indentOf(line);
    if (lineIndent <= stopIndent) return -1;
    if (lineIndent === indent && new RegExp(`^\\s*${key}\\s*:\\s*$`).test(line)) return i;
  }
  return -1;
}

function scanAllowlists(text) {
  const lines = text.split("\n");
  const networkPolicyLine = findTopLevelKey(lines, "networkPolicy");
  if (networkPolicyLine === -1) return { providerAllowlist: [], providerAllowlistSuffixes: [] };

  const allowlistLine = findNestedKey(lines, networkPolicyLine + 1, 2, "providerAllowlist", 0);
  const providerAllowlist =
    allowlistLine === -1 ? [] : scanListOfMaps(lines, allowlistLine + 1, 2).entries;

  const suffixesLine = findNestedKey(lines, networkPolicyLine + 1, 2, "providerAllowlistSuffixes", 0);
  const providerAllowlistSuffixes =
    suffixesLine === -1 ? [] : scanListOfMaps(lines, suffixesLine + 1, 2).entries;

  return { providerAllowlist, providerAllowlistSuffixes };
}

/** Scans `components.<name>` blocks for kind/repository/network.allowProviderEgress. */
function scanComponents(text) {
  const lines = text.split("\n");
  const componentsLine = findTopLevelKey(lines, "components");
  if (componentsLine === -1) return [];

  const components = [];
  let i = componentsLine + 1;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "") {
      i += 1;
      continue;
    }
    const line = stripComment(raw);
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) break; // dedented out of components:

    const nameMatch = /^ {2}([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*$/.exec(line);
    if (!nameMatch) {
      i += 1;
      continue;
    }
    const name = nameMatch[1];
    const component = { name, enabled: false, kind: null, repository: null, hasNetworkBlock: false, allowProviderEgress: false };

    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const innerRaw = lines[j];
      if (innerRaw.trim() === "") continue;
      const inner = stripComment(innerRaw);
      if (inner.trim() === "") continue;
      const innerIndent = indentOf(inner);
      if (innerIndent <= 2) break; // next component or dedent out of components:

      if (innerIndent === 4) {
        const fieldMatch = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*(.*?)\s*$/.exec(inner);
        if (fieldMatch) {
          const [, field, value] = fieldMatch;
          if (field === "enabled") component.enabled = value.trim() === "true";
          if (field === "kind") component.kind = unquote(value);
          if (field === "repository") component.repository = unquote(value);
          if (field === "network" && value === "") component.hasNetworkBlock = true;
        }
      }
      if (innerIndent === 6 && component.hasNetworkBlock) {
        const fieldMatch = /^\s*allowProviderEgress\s*:\s*(.*?)\s*$/.exec(inner);
        if (fieldMatch) component.allowProviderEgress = fieldMatch[1].trim() === "true";
      }
    }
    components.push(component);
    i = j;
  }
  return components;
}

async function checkValuesShape(root) {
  const valuesText = await readFile(join(root, CHART_DIR, "values.yaml"), "utf8");
  const { providerAllowlist, providerAllowlistSuffixes } = scanAllowlists(valuesText);
  const components = scanComponents(valuesText);

  let problems = [];

  for (const entry of providerAllowlist) {
    if (!entry.host) problems.push(`providerAllowlist entry missing a 'host': ${JSON.stringify(entry)}`);
    if (!entry.reason) problems.push(`providerAllowlist entry for ${entry.host} missing a 'reason'`);
  }
  for (const entry of providerAllowlistSuffixes) {
    if (!entry.host || !entry.host.startsWith(".")) {
      problems.push(`providerAllowlistSuffixes entry must have a host starting with '.': ${JSON.stringify(entry)}`);
    }
    if (!entry.reason) problems.push(`providerAllowlistSuffixes entry for ${entry.host} missing a 'reason'`);
  }

  for (const c of components) {
    if (!c.enabled) continue;
    if (!c.kind) problems.push(`component '${c.name}' is missing 'kind'`);
    if (!c.repository) problems.push(`component '${c.name}' is missing 'repository'`);
    if (!c.hasNetworkBlock) problems.push(`component '${c.name}' is missing a 'network' block`);
  }

  if (problems.length === 0) {
    ok(
      `values.yaml: ${String(providerAllowlist.length)} allow-list host(s), ` +
        `${String(providerAllowlistSuffixes.length)} suffix host(s), ` +
        `${String(components.length)} component(s) — shape is consistent`,
    );
  } else {
    for (const p of problems) fail(`values.yaml: ${p}`);
  }

  // Mode-independent: off/audit/enforce differ only in *when* the allow-list is
  // enforced, never in whether one needs to exist for a provider-egress component.
  const anyProviderEgress = components.some((c) => c.enabled && c.allowProviderEgress);
  const allowlistEmpty = providerAllowlist.length === 0 && providerAllowlistSuffixes.length === 0;
  if (anyProviderEgress && allowlistEmpty) {
    fail(
      `fqdn.mode=enforce (the eventual target of ${FQDN_MODES.join("/")}) with a component that has ` +
        "allowProviderEgress=true, but the allow-list is empty — that component would be dropped " +
        "from all provider egress",
    );
  } else {
    ok("allow-list is non-empty for every provider-egress component, across off/audit/enforce");
  }
}

async function checkEnvValues(root, envName) {
  const path = join(root, CHART_DIR, `values-${envName}.yaml`);
  const text = await readFile(path, "utf8");
  const match = /^\s*mode\s*:\s*"?([a-z]+)"?\s*$/m.exec(text);
  if (match && !FQDN_MODES.includes(match[1])) {
    fail(`values-${envName}.yaml sets networkPolicy.fqdn.mode to ${JSON.stringify(match[1])}, expected one of ${FQDN_MODES.join("/")}`);
    return;
  }
  ok(`values-${envName}.yaml: fqdn.mode is ${match ? match[1] : "unset (defaults to values.yaml)"}, a recognised value`);
}

/** Counts a Go-template action's opens vs. closes on a stripped-comment copy of the file. */
function checkBalancedActions(text, filename) {
  const withoutComments = text.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, "");
  const opens = (withoutComments.match(/\{\{-?\s*(?:if|range|with|define)\b/g) ?? []).length;
  const closes = (withoutComments.match(/\{\{-?\s*end\s*-?\}\}/g) ?? []).length;
  if (opens !== closes) {
    fail(
      `${filename}: unbalanced Helm template actions (${String(opens)} if/range/with/define vs. ` +
        `${String(closes)} end) — a real 'helm template' would fail to parse this`,
    );
    return false;
  }
  return true;
}

async function checkTemplates(root) {
  const templatesDir = join(root, CHART_DIR, "templates");
  const files = (await readdir(templatesDir)).filter(
    (name) => name.endsWith(".yaml") || name.endsWith(".tpl"),
  );
  if (files.length === 0) {
    fail(`no template files found under ${templatesDir}`);
    return;
  }
  let allBalanced = true;
  for (const name of files) {
    const text = await readFile(join(templatesDir, name), "utf8");
    if (!checkBalancedActions(text, name)) allBalanced = false;
  }
  if (allBalanced) ok(`${String(files.length)} template file(s) have balanced if/range/with/define...end`);
}

async function main() {
  const root = process.cwd();
  await checkChartYaml(root);
  await checkValuesShape(root);
  await checkEnvValues(root, "staging");
  await checkEnvValues(root, "prod");
  await checkTemplates(root);

  if (failed) {
    process.stderr.write(
      "\nvalidate-chart-local — this is a structural stand-in only. Before merging, also run the " +
        "real gate (requires Helm 3 + kubeconform, as installed in .github/workflows/infra.yml):\n" +
        "  helm lint infra/k8s/montaj\n" +
        "  helm template montaj infra/k8s/montaj -f infra/k8s/montaj/values-prod.yaml " +
        "--set networkPolicy.fqdn.mode=enforce | kubeconform -strict -summary\n",
    );
    process.exit(1);
  }
  process.stdout.write("validate-chart-local — all checks passed\n");
}

await main();
