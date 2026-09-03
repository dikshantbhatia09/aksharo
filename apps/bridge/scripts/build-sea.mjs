#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

  copyTraybin();

  console.log(`built ${outputPath}`);
}

/**
 * Copies `systray2`'s prebuilt per-OS helper binaries to `dist/traybin/`, next
 * to the packaged executable (`native-tray.ts`'s `traybinDirectories()` looks
 * there first). The SEA blob has no `node_modules` of its own, so these files
 * — never committed to the repo, only ever copied out of the installed
 * dependency at build time — are how the native tray finds its helper binary
 * once the app is packaged. Missing them is not fatal: `createNativeTray`
 * falls back to the console tray if `dist/traybin` is absent.
 */
function copyTraybin() {
  // Off by default (coordinator ruling, 2026-09-03): the native tray itself
  // is opt-in at runtime (AKSHARO_BRIDGE_TRAY=native, see native-tray.ts), and
  // a default build should not even carry the unmaintained systray2 helper
  // binaries into the signed artifact — set the same flag at build time to
  // include them.
  if (process.env.AKSHARO_BRIDGE_TRAY !== "native") {
    console.log(
      "AKSHARO_BRIDGE_TRAY!=native; skipping tray helper binary copy (console fallback only)",
    );
    return;
  }
  const require = createRequire(import.meta.url);
  let traybinSrc;
  try {
    traybinSrc = join(dirname(require.resolve("systray2/package.json")), "traybin");
  } catch {
    console.warn("systray2 not installed; packaged binary will fall back to the console tray");
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (!existsSync(traybinSrc)) {
    console.warn(`systray2 traybin not found at ${traybinSrc}; skipping`);
    return;
  }
  const traybinDest = join(dist, "traybin");
  rmSync(traybinDest, { recursive: true, force: true });
  cpSync(traybinSrc, traybinDest, { recursive: true });
  console.log(`copied tray helper binaries to ${traybinDest}`);
}

main();
