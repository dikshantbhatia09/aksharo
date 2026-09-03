import fs from "node:fs/promises";
import path from "node:path";

import { PLUGIN_IDS } from "@montaj/config/brand";

import { ZXP_SIGN_SECRETS, requireSecretsIfSigned } from "../env.js";
import { execCommand } from "../lib/exec.js";
import { ensureDir, pathExists } from "../lib/fsUtil.js";
import { zipDirectory } from "../lib/zip.js";

import type { ReleaseContext } from "../types.js";

export interface SignZxpOptions {
  pluginDir: string;
  version: string;
}

export interface SignZxpResult {
  zxpPath: string;
  signed: boolean;
  placeholderPlugin: boolean;
}

/**
 * `sign-zxp`: packages the AE CEP panel and signs it with ZXPSignCmd. Dry-run generates a
 * self-signed dev cert marker instead of calling the real tool (hard rule: never sign for
 * real); signed mode requires a real `.p12` + timestamp server (RR-03 D6: ZXPSignCmd is
 * flaky, so the real invocation retries once without `-tsa` on timeout — left as a TODO
 * hook for C07, tracked, not implemented here since AE panel code doesn't exist yet).
 */
export async function runSignZxp(
  ctx: ReleaseContext,
  opts: SignZxpOptions,
): Promise<SignZxpResult> {
  requireSecretsIfSigned(ctx.mode, ZXP_SIGN_SECRETS);

  const absPluginDir = path.isAbsolute(opts.pluginDir)
    ? opts.pluginDir
    : path.join(ctx.repoRoot, opts.pluginDir);
  let sourceDir = absPluginDir;
  let placeholderPlugin = false;
  if (!(await pathExists(path.join(absPluginDir, "CSXS", "manifest.xml")))) {
    placeholderPlugin = true;
    sourceDir = path.join(ctx.outDir, "build-zxp", "placeholder-plugin");
    await ensureDir(path.join(sourceDir, "CSXS"));
    await fs.writeFile(
      path.join(sourceDir, "CSXS", "manifest.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<ExtensionManifest ExtensionBundleId="${PLUGIN_IDS.afterEffectsCep}" ExtensionBundleVersion="${opts.version}" Version="10.0" />\n`,
      "utf8",
    );
  } else {
    // A real plugin source tree (C05b+) has its `package.json`/`src/**/*.ts`/tests/
    // `node_modules` alongside the shippable files — zipping `absPluginDir` as-is would ship
    // the whole dev tree (brief: "the .zxp contains manifest + bundle + jsx only"), and pnpm's
    // symlinked `node_modules` breaks the dependency-free ZIP fallback in `zip.ts` (same reason
    // `packageCcx.ts` stages the UXP plugin instead of zipping its source dir directly). Stage
    // only the shippable subset instead.
    sourceDir = path.join(ctx.outDir, "build-zxp", "staged-plugin");
    await ensureDir(sourceDir);
    await stageShippableFiles(absPluginDir, sourceDir);
  }

  const unsignedZxp = path.join(ctx.outDir, "build-zxp", `aksharo-ae-${opts.version}.unsigned.zxp`);
  await zipDirectory(sourceDir, unsignedZxp);

  const zxpPath = path.join(ctx.outDir, "artifacts", "plugins", `aksharo-ae-${opts.version}.zxp`);
  await ensureDir(path.dirname(zxpPath));

  if (ctx.mode === "signed") {
    await execCommand("ZXPSignCmd", [
      "-sign",
      sourceDir,
      zxpPath,
      process.env.ZXP_CERT_P12_BASE64 ?? "",
      process.env.ZXP_CERT_PASSWORD ?? "",
      "-tsa",
      process.env.ZXP_TIMESTAMP_URL ?? "",
    ]);
    return { zxpPath, signed: true, placeholderPlugin };
  }

  await fs.copyFile(unsignedZxp, zxpPath);
  await fs.writeFile(
    `${zxpPath}.UNSIGNED`,
    "UNSIGNED (dry-run) — self-signed dev cert would be used in a real run\n",
    "utf8",
  );
  return { zxpPath, signed: false, placeholderPlugin };
}

/** Files/directories the AE CEP panel ships; everything else in the source tree (package.json,
 * src/**\/*.ts, tests, node_modules, docs) is dev-only. `src/jsx` ships as source (ExtendScript
 * is never bundled/minified — CEP loads it directly via `CSXS/manifest.xml`'s `ScriptPath`). */
const SHIPPABLE_ENTRIES = ["CSXS", "index.html", "dist", "src/jsx", "icons"];

async function stageShippableFiles(fromDir: string, toDir: string): Promise<void> {
  for (const entry of SHIPPABLE_ENTRIES) {
    const src = path.join(fromDir, entry);
    if (!(await pathExists(src))) continue;
    await fs.cp(src, path.join(toDir, entry), { recursive: true, dereference: true });
  }
}
