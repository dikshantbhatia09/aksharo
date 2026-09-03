#!/usr/bin/env node
/**
 * Emits `packages/config/contract-env-vars.json`: `CONTRACT_ENV_VARS` from
 * `env.ts`, as plain JSON, so services outside the TypeScript workspace (the
 * Python AI worker) can read the same frozen list instead of keeping their own
 * hand-copied tuple that silently drifts (M04, after `LICENSE_SIGNING_KID` was
 * added to `env.ts` but never to `apps/worker-ai/worker_ai/settings.py`).
 *
 * Runs as part of `pnpm --filter @montaj/config build`. Plain Node, no
 * TypeScript compile needed, so it can also be run standalone:
 *   node packages/config/src/emit-contract-env.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envTsPath = path.join(here, "env.ts");
const outPath = path.join(here, "..", "contract-env-vars.json");

const src = readFileSync(envTsPath, "utf-8");
const marker = "CONTRACT_ENV_VARS = [";
const start = src.indexOf(marker);
if (start === -1) {
  throw new Error(`could not find "${marker}" in ${envTsPath}`);
}
const block = src.slice(start + marker.length).split("] as const", 1)[0];
const names = [...block.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
if (names.length === 0) {
  throw new Error(`parsed zero env var names from ${envTsPath}`);
}

writeFileSync(outPath, `${JSON.stringify(names, null, 2)}\n`, "utf-8");
// eslint-disable-next-line no-console -- this is a build script; stdout is its status line.
console.log(`emit-contract-env: wrote ${names.length} names to ${outPath}`);
