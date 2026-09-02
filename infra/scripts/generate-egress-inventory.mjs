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
import { join } from "node:path";

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
              `  ${host}\n` +
              occurrences.map((o) => `    ${o.file}:${String(o.line)}`).join("\n"),
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
  const serialised = `${JSON.stringify(document, null, 2)}\n`;

  if (check) {
    let existing = "";
    try {
      existing = await readFile(outputPath, "utf8");
    } catch {
      fail(`${OUTPUT_RELATIVE} does not exist — run without --check to create it`);
    }
    if (existing !== serialised) {
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

  await writeFile(outputPath, serialised, "utf8");
  process.stdout.write(
    `generate-egress-inventory — wrote ${OUTPUT_RELATIVE} with ${String(entries.length)} host(s)\n`,
  );
}

await main();
