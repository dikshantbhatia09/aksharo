import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSignZxp } from "../src/commands/signZxp.js";
import { createContext } from "../src/config.js";

/**
 * C05b: once `plugins/ae-cep` has a real `CSXS/manifest.xml`, `sign-zxp` must stage only the
 * shippable subset (manifest + bundle + jsx, per the brief) rather than zipping the whole dev
 * tree — the same reason `packageCcx.ts` stages the UXP plugin instead of zipping its source
 * dir directly (dev-only files, and pnpm's symlinked `node_modules`, would otherwise ship, and
 * the dependency-free ZIP fallback in `zip.ts` doesn't follow symlinks).
 */
describe("sign-zxp against a real (non-placeholder) plugin tree", () => {
  let repoRoot: string;
  let outDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "release-repo-zxp-real-"));
    outDir = path.join(repoRoot, ".release");

    const pluginDir = path.join(repoRoot, "plugins", "ae-cep");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(path.join(pluginDir, "CSXS"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      path.join(pluginDir, "CSXS", "manifest.xml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<ExtensionManifest ExtensionBundleId="ai.aksharo.ae" ExtensionBundleVersion="0.1.0" Version="10.0" />\n',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(pluginDir, "index.html"), "<!-- panel entry -->\n");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(path.join(pluginDir, "dist"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(pluginDir, "dist", "panel.js"), "// bundled panel\n");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(path.join(pluginDir, "src", "jsx"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(pluginDir, "src", "jsx", "aksharo.jsx"), "// extendscript\n");

    // Dev-only files that must NOT be shipped.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(pluginDir, "package.json"), "{}\n");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(path.join(pluginDir, "src", "host"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(pluginDir, "src", "host", "ae.ts"), "// dev source, not shipped\n");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(path.join(pluginDir, "node_modules", "some-dep"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(pluginDir, "node_modules", "some-dep", "index.js"), "// dep\n");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function ctx() {
    return createContext({ repoRoot, outDir, mode: "dry-run", now: () => 1_700_000_000_000 });
  }

  it("stages only CSXS, index.html, dist and src/jsx — never package.json, other src/, or node_modules", async () => {
    const result = await runSignZxp(ctx(), { pluginDir: "plugins/ae-cep", version: "0.1.0" });
    expect(result.placeholderPlugin).toBe(false);
    expect(result.signed).toBe(false);

    const stagedDir = path.join(outDir, "build-zxp", "staged-plugin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const staged = await readdir(stagedDir);
    expect(staged.sort()).toEqual(["CSXS", "dist", "index.html", "src"]);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const stagedSrc = await readdir(path.join(stagedDir, "src"));
    expect(stagedSrc).toEqual(["jsx"]);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const stagedJsx = await readdir(path.join(stagedDir, "src", "jsx"));
    expect(stagedJsx).toEqual(["aksharo.jsx"]);
  });
});
