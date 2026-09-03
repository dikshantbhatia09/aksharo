import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPackageResolve } from "../src/commands/packageResolve.js";
import { createContext } from "../src/config.js";

import type { ReleaseConfig } from "../src/config.js";

describe("package-resolve installer (C10): Free/Studio install + uninstall + version file + macros", () => {
  let repoRoot: string;
  let outDir: string;

  const config: ReleaseConfig = {
    appId: "ai.aksharo.desktop",
    productName: "Aksharo",
    desktopAppDir: "apps/desktop",
    mac: { target: ["dmg", "zip"], category: "public.app-category.video" },
    win: { target: "nsis", arch: "x64" },
    ccx: { pluginDir: "plugins/premiere-uxp", minPremiereVersion: "25.6" },
    zxp: { pluginDir: "plugins/ae-cep" },
    resolveBundle: {
      scriptDir: "plugins/resolve",
      installPaths: {
        win: "%APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility",
        mac: "~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility",
        linux: "~/.local/share/DaVinciResolve/Fusion/Scripts/Utility",
      },
    },
    channels: ["alpha", "beta", "stable"],
  };

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "release-repo-resolve-"));
    outDir = path.join(repoRoot, ".release");
    // The real manifest.json (plugins/resolve/installer/manifest.json) with no matching
    // macro file on disk -- this WP's test repo never lands the real C08b macro output.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(path.join(repoRoot, "plugins", "resolve", "installer"), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      path.join(repoRoot, "plugins", "resolve", "installer", "manifest.json"),
      JSON.stringify({
        version: 1,
        macros: [
          {
            id: "aksharo-caption",
            file: "aksharo_core_app/fusion/AksharoCaption.setting",
            installTo: {
              win: "%APPDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Fusion\\Macros",
              mac: "~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Macros",
              linux: "~/.local/share/DaVinciResolve/Fusion/Macros",
            },
          },
        ],
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function ctx() {
    return createContext({ repoRoot, outDir, mode: "dry-run", now: () => 1_700_000_000_000 });
  }

  it("stages a VERSION file, install/uninstall scripts for both platforms, and skips a missing macro", async () => {
    const result = await runPackageResolve(ctx(), config, "1.2.3");
    expect(result.placeholderPlugin).toBe(true);
    expect(result.macrosStaged).toEqual([]); // macro file doesn't exist on disk in this test

    const staged = path.join(outDir, "build-resolve", "staged-plugin");

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const version = await readFile(path.join(staged, "VERSION"), "utf8");
    expect(version.trim()).toBe("1.2.3");

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const installSh = await readFile(path.join(staged, "install.sh"), "utf8");
    expect(installSh).toContain("Free and Studio");
    expect(installSh).toContain("aksharo-resolve.VERSION");

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const uninstallSh = await readFile(path.join(staged, "uninstall.sh"), "utf8");
    expect(uninstallSh).toContain("rm -f");
    expect(uninstallSh).toContain("aksharo-resolve.VERSION");

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const uninstallPs1 = await readFile(path.join(staged, "uninstall.ps1"), "utf8");
    expect(uninstallPs1).toContain("Remove-Item");
  });

  it("stages a real macro file when C08b has landed it and copies it into the bundle's macros/ dir", async () => {
    const macroDir = path.join(repoRoot, "plugins", "resolve", "aksharo_core_app", "fusion");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(macroDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path.join(macroDir, "AksharoCaption.setting"), "-- fusion macro --\n", "utf8");

    const result = await runPackageResolve(ctx(), config, "1.2.3");
    expect(result.macrosStaged).toEqual(["aksharo-caption"]);

    const staged = path.join(outDir, "build-resolve", "staged-plugin");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const macro = await readFile(path.join(staged, "macros", "AksharoCaption.setting"), "utf8");
    expect(macro).toContain("fusion macro");

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const installPs1 = await readFile(path.join(staged, "install.ps1"), "utf8");
    expect(installPs1).toContain("AksharoCaption.setting");
  });
});
