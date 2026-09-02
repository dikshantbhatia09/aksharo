#!/usr/bin/env node
/**
 * Thin wrapper around `electron-builder` that sources `extraMetadata`
 * (`version`, `productName`) from `@montaj/config`'s `BRAND` and this
 * package's own `package.json` version (C00b brief §2), so
 * `electron-builder.yml` never hardcodes values that could drift from
 * `docs/CONTRACTS.md` §0's single source of brand strings.
 *
 * Usage: `node scripts/pack.mjs --dir` (forwards all argv through to
 * electron-builder alongside the computed `-c.extraMetadata.*` overrides).
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function main() {
  const { BRAND } = await import("@montaj/config/brand");
  const appPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  const electronBuilderBin = require.resolve("electron-builder/out/cli/cli.js");
  const args = [
    electronBuilderBin,
    "--config",
    "electron-builder.yml",
    "-c.electronDist=node_modules/electron/dist",
    `-c.extraMetadata.version=${appPkg.version}`,
    `-c.extraMetadata.productName=${BRAND.name}`,
    ...process.argv.slice(2),
  ];
  console.log(`$ node ${args.join(" ")}`);
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: root });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
