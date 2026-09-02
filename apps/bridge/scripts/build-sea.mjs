#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Builds the Node 22 single-executable application (brief §5): bundle
 * `dist/main.js` into a self-contained blob via `node --experimental-sea-config`,
 * copy the current `node` binary, and inject the blob with `postject` (the tool
 * Node's own SEA docs use, https://nodejs.org/api/single-executable-applications.html).
 *
 * Signing (macOS codesign / Windows Authenticode) is C00's job (the release
 * pipeline); this script only produces the unsigned platform binary from
 * whichever OS it runs on — that is why the CI matrix job (`.github/workflows/ci.yml`)
 * runs it once per runner OS rather than cross-compiling here.
 */

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const dist = join(root, "dist");
const blobPath = join(dist, "bridge.blob");
const isWindows = process.platform === "win32";
const outputName = isWindows ? "aksharo-bridge.exe" : "aksharo-bridge";
const outputPath = join(dist, outputName);

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: root });
}

function bundle() {
  // A Node SEA blob has no `node_modules` resolution of its own (the built-in
  // module loader that runs `dist/main.js` inside the executable only knows
  // Node's own builtins), so everything `main.js` requires — `@montaj/bridge-core`
  // included — is bundled into one CommonJS file first with esbuild.
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");
  esbuild.buildSync({
    entryPoints: [join(dist, "main.js")],
    outfile: join(dist, "bundle.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: [],
  });
}

function main() {
  if (!existsSync(join(dist, "main.js"))) {
    console.error("dist/main.js not found — run `pnpm build` first.");
    process.exit(1);
  }
  mkdirSync(dist, { recursive: true });
  bundle();

  run(process.execPath, ["--experimental-sea-config", "sea-config.json"]);

  copyFileSync(process.execPath, outputPath);
  if (!isWindows) {
    // codesign removes the existing signature area the copy inherited; SEA
    // injection needs that space back before its own (later, C00) signing pass.
    try {
      execFileSync("codesign", ["--remove-signature", outputPath], { stdio: "ignore" });
    } catch {
      // No codesign available (Linux CI runner) — nothing to remove.
    }
  }

  const require = createRequire(import.meta.url);
  const postjectBin = require.resolve("postject/dist/cli.js");
  const postjectArgs = [
    postjectBin,
    outputPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
  // `postject` itself, not `npx`: resolving through npx depends on PATH shape
  // (and on Windows, the `.cmd` shim) that CI runners and local shells do not
  // always agree on; requiring the package's own CLI entry is unambiguous.
  run(process.execPath, postjectArgs);

  console.log(`built ${outputPath}`);
}

main();
