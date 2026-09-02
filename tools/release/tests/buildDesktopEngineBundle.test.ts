import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildDesktop } from "../src/commands/buildDesktop.js";
import { createContext } from "../src/config.js";

import type { ReleaseConfig } from "../src/config.js";

/**
 * C03a: `build-desktop` bundles the engine supervisor's built output
 * (`apps/engine/dist`) into the app tree's resources, dry run, when it
 * exists — additive to C02b's real/placeholder app-tree logic and never
 * touching signing (C00) or packaging (C00b).
 */
describe("build-desktop bundles the engine supervisor (C03a)", () => {
  let repoRoot: string;
  let outDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "release-repo-engine-"));
    outDir = path.join(repoRoot, ".release");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function ctx() {
    return createContext({ repoRoot, outDir, mode: "dry-run", now: () => 1_700_000_000_000 });
  }

  const config: ReleaseConfig = {
    appId: "ai.aksharo.desktop",
    productName: "Aksharo",
    desktopAppDir: "apps/desktop",
    mac: { target: ["dmg", "zip"], category: "public.app-category.video" },
    win: { target: "nsis", arch: "x64" },
    ccx: { pluginDir: "plugins/premiere-uxp-does-not-exist", minPremiereVersion: "25.6" },
    zxp: { pluginDir: "plugins/ae-cep-does-not-exist" },
    resolveBundle: {
      scriptDir: "plugins/resolve-does-not-exist",
      installPaths: { win: "w", mac: "m", linux: "l" },
    },
    channels: ["alpha", "beta", "stable"],
  };

  it("reports engineBundled: false when apps/engine has not been built", async () => {
    const result = await runBuildDesktop(ctx(), config, { platform: "win", channel: "alpha", dryRun: true });
    expect(result.engineBundled).toBe(false);
  });

  it("copies apps/engine/dist into win-unpacked/resources/engine when it exists", async () => {
    const engineDist = path.join(repoRoot, "apps", "engine", "dist");
    await mkdir(engineDist, { recursive: true });
    await writeFile(path.join(engineDist, "main.js"), "// built engine supervisor\n");

    const result = await runBuildDesktop(ctx(), config, { platform: "win", channel: "alpha", dryRun: true });
    expect(result.engineBundled).toBe(true);

    const copied = await readFile(
      path.join(result.appDir, "win-unpacked", "resources", "engine", "main.js"),
      "utf8",
    );
    expect(copied).toContain("built engine supervisor");
  });

  it("copies into Contents/Resources/engine on mac", async () => {
    const engineDist = path.join(repoRoot, "apps", "engine", "dist");
    await mkdir(engineDist, { recursive: true });
    await writeFile(path.join(engineDist, "main.js"), "// built engine supervisor\n");

    const result = await runBuildDesktop(ctx(), config, { platform: "mac", channel: "alpha", dryRun: true });
    expect(result.engineBundled).toBe(true);

    const copied = await readFile(
      path.join(result.appDir, "Aksharo.app", "Contents", "Resources", "engine", "main.js"),
      "utf8",
    );
    expect(copied).toContain("built engine supervisor");
  });

  it("does not add the bundled engine's .js files to the nested-binary sign list", async () => {
    const engineDist = path.join(repoRoot, "apps", "engine", "dist");
    await mkdir(engineDist, { recursive: true });
    await writeFile(path.join(engineDist, "main.js"), "// built engine supervisor\n");

    const result = await runBuildDesktop(ctx(), config, { platform: "win", channel: "alpha", dryRun: true });
    expect(result.signed.some((s) => s.path.includes("main.js"))).toBe(false);
  });
});
