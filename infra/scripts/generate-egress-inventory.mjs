#!/usr/bin/env node
/**
 * Generates `infra/policies/egress-inventory.json` (X08 scope item 1).
 *
 * Scans `apps/api/src`, `apps/worker-ai`, `apps/worker-media/src`,
 * `apps/render/src` and `apps/model-server` for outbound hostnames (see
 * `egress-hosts.mjs` for the exact patterns), cross-references every hostname
 * found against the `VENDOR_METADATA` table, and writes the merged result.
 *
 * Exits 1 — and writes nothing — if a hostname is found in code with no
 * metadata entry: that is the point of this generator being a gate rather than
 * a convenience script. Add the vendor to `VENDOR_METADATA` in
 * `egress-hosts.mjs` (with an owner and a purpose) before the inventory can be
 * regenerated.
 *
 *   node infra/scripts/generate-egress-inventory.mjs
 *   node infra/scripts/generate-egress-inventory.mjs --check   # like prettier --check: no write, exit 1 on drift
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildInventory } from "./egress-hosts.mjs";

const OUTPUT_RELATIVE = "infra/policies/egress-inventory.json";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function fail(message) {
  process.stderr.write(`generate-egress-inventory — ${message}\n`);
  process.exit(1);
}

async function main() {
  const root = repoRoot();
  const outputPath = join(root, OUTPUT_RELATIVE);
  const check = process.argv.includes("--check");

  const { entries, unknown } = await buildInventory(root);

  if (unknown.length > 0) {
    fail(
      `${unknown.length} outbound host(s) found in code with no metadata entry:\n` +
        unknown
          .map(
            ({ host, occurrences }) =>
              `  ${host}\n` + occurrences.map((o) => `    ${o.file}:${String(o.line)}`).join("\n"),
          )
          .join("\n") +
        `\nAdd each to VENDOR_METADATA in infra/scripts/egress-hosts.mjs with an owner and a purpose, ` +
        `then re-run this generator.`,
    );
  }

  const document = {
    $schema: "https://aksharo.ai/schemas/egress-inventory-v1.json",
    generatedBy: "infra/scripts/generate-egress-inventory.mjs",
    // Deliberately excluded from the JSON: a timestamp would make every
    // regeneration a diff even when nothing about the inventory changed,
    // which is exactly the noise `--check` exists to avoid.
    entries,
  };

  if (check) {
    // Structural comparison only, deliberately not byte-for-byte: `--check`
    // is the CI gate (`.github/workflows/infra.yml`'s `infra-validate`, which
    // never runs `pnpm install`), so it must not depend on Prettier being
    // resolvable. A real formatting drift is `pnpm format:changed:check`'s
    // job, not this script's — this only asks "does the committed file
    // reflect the current code scan," which JSON.parse + a content compare
    // answers without caring how the file is indented.
    let existingText = "";
    try {
      existingText = await readFile(outputPath, "utf8");
    } catch {
      fail(`${OUTPUT_RELATIVE} does not exist — run without --check to create it`);
    }
    let existingDocument;
    try {
      existingDocument = JSON.parse(existingText);
    } catch (error) {
      fail(
        `${OUTPUT_RELATIVE} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (JSON.stringify(existingDocument.entries) !== JSON.stringify(document.entries)) {
      fail(
        `${OUTPUT_RELATIVE} is out of date with the code scan. Run: ` +
          `node infra/scripts/generate-egress-inventory.mjs`,
      );
    }
    process.stdout.write(
      `generate-egress-inventory — up to date, ${String(entries.length)} host(s)\n`,
    );
    return;
  }

  // Write mode: formatted through the workspace's own Prettier when it is
  // resolvable — the same Prettier `pnpm format:changed:check` runs, so the
  // committed file matches what that separate gate expects (Prettier
  // collapses a short array like `"workloads": ["api"]` onto one line; plain
  // `JSON.stringify(..., null, 2)` never does). This is the developer-facing
  // path (`node infra/scripts/generate-egress-inventory.mjs`, run where
  // `pnpm install` has already happened) — CI only ever runs `--check` above,
  // which needs none of this.
  let serialised;
  try {
    const require = createRequire(pathToFileURL(join(root, "package.json")));
    const loaded = await import(pathToFileURL(require.resolve("prettier", { paths: [root] })).href);
    const prettier = typeof loaded.format === "function" ? loaded : loaded.default;
    serialised = await prettier.format(JSON.stringify(document), {
      ...(await prettier.resolveConfig(outputPath)),
      filepath: outputPath,
    });
  } catch {
    serialised = `${JSON.stringify(document, null, 2)}\n`;
    process.stderr.write(
      "generate-egress-inventory — could not resolve Prettier (run `pnpm install` first); " +
        `wrote plain-JSON formatting instead. Run: pnpm format:changed -- ${OUTPUT_RELATIVE}\n`,
    );
  }

  await writeFile(outputPath, serialised, "utf8");
  process.stdout.write(
    `generate-egress-inventory — wrote ${OUTPUT_RELATIVE} with ${String(entries.length)} host(s)\n`,
  );
}

await main();
