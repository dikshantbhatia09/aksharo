#!/usr/bin/env node
/**
 * Bundles the Electron main/preload/pairing-preload entry points with esbuild
 * into single CommonJS files under `dist/**` (C00b brief §1-2).
 *
 * Why: `electron-builder --dir` over a plain `tsc` output keeps
 * `node_modules/@montaj/{bridge-core,config}` as pnpm symlinks whose real
 * path resolves to `packages/*`, outside `apps/desktop/`; app-builder-lib's
 * asar packager then throws `"<file> must be under <appDir>"` for every file
 * under those packages (see `tools/release/src/commands/buildDesktop.ts`'s
 * `findRealElectronBuilderOutput` doc comment, and `apps/desktop/README.md`'s
 * "Known blocker" note, both written up by C02b). Bundling every workspace
 * dependency straight into the entry file — the same esbuild-into-one-file
 * discipline `apps/bridge/scripts/build-sea.mjs` (C01) already uses for the
 * bridge SEA build — means the packaged app never has a `node_modules`
 * dependency on a workspace symlink at all: `electron-builder.yml` points
 * `directories.app` at this `dist/` tree, which carries its own minimal,
 * dependency-free `package.json` (`writeDistPackageJson` below), so
 * electron-builder's node_modules walk finds nothing to resolve.
 *
 * Externals: only `electron` (host-provided) and Node builtins (esbuild's
 * `platform: "node"` marks these external automatically). There are no
 * native addons in this dependency graph (`@montaj/bridge-core`,
 * `@montaj/config`, `electron-updater`, `ws`, `selfsigned`, `ulid`, `zod` are
 * all pure JS) so everything else is inlined.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

/** External at bundle time: the Electron host API and Node's own builtins
 * (the latter excluded automatically by esbuild's `platform: "node"`). */
export const EXTERNALS = ["electron"];

const ENTRIES = [
  { in: join(root, "src", "main", "index.ts"), out: join(dist, "main", "index.js") },
  { in: join(root, "src", "preload", "index.ts"), out: join(dist, "preload", "index.js") },
  {
    in: join(root, "src", "main", "pairing-preload.ts"),
    out: join(dist, "main", "pairing-preload.js"),
  },
];

export async function bundleEntry(entry) {
  await esbuild.build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: EXTERNALS,
    sourcemap: false, // never ship source maps in the packaged app
    logLevel: "info",
  });
}

/**
 * Minimal `package.json` for the `dist/` app directory electron-builder packs
 * (`directories.app: dist` in `electron-builder.yml`) — no `dependencies`, so
 * electron-builder's production-dependency walk (the thing that hit the
 * pnpm-symlink bug above) has nothing to resolve. `main`/`name`/`version` are
 * the only fields electron-builder actually reads from this file; the real
 * `productName`/`appId`/etc. come from `electron-builder.yml` + `extraMetadata`.
 */
export async function writeDistPackageJson(appDir = root, distDir = dist) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const appPkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
  const distPkg = {
    name: appPkg.name,
    version: appPkg.version,
    private: true,
    main: "main/index.js",
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  await writeFile(join(distDir, "package.json"), `${JSON.stringify(distPkg, null, 2)}\n`, "utf8");
  return distPkg;
}

async function main() {
  for (const entry of ENTRIES) {
    await bundleEntry(entry);
  }
  await writeDistPackageJson();
  console.log(`bundled ${ENTRIES.length} entr${ENTRIES.length === 1 ? "y" : "ies"} into ${dist}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
