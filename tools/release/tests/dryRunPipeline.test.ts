import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildDesktop } from "../src/commands/buildDesktop.js";
import { runChecksums } from "../src/commands/checksums.js";
import { runNotarize } from "../src/commands/notarize.js";
import { runPackageCcx } from "../src/commands/packageCcx.js";
import { runPackageResolve } from "../src/commands/packageResolve.js";
import { runPromote } from "../src/commands/promote.js";
import { runPublish } from "../src/commands/publish.js";
import { runSignZxp } from "../src/commands/signZxp.js";
import { runVerifyRelease } from "../src/commands/verifyRelease.js";
import { createContext } from "../src/config.js";

import type { ReleaseConfig } from "../src/config.js";

const config: ReleaseConfig = {
  appId: "ai.aksharo.desktop",
  productName: "Aksharo",
  desktopAppDir: "apps/desktop-does-not-exist",
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

describe("dry-run pipeline (no real signing, no real network)", () => {
  let repoRoot: string;
  let outDir: string;
  let now: number;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "release-repo-"));
    outDir = path.join(repoRoot, ".release");
    now = 1_700_000_000_000;
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function ctx(overrides: Partial<{ mode: "dry-run" | "signed" }> = {}) {
    return createContext({ repoRoot, outDir, mode: overrides.mode ?? "dry-run", now: () => now });
  }

  it("build-desktop produces an unsigned artifact against a placeholder app and reports it", async () => {
    const result = await runBuildDesktop(ctx(), config, {
      platform: "win",
      channel: "alpha",
      dryRun: true,
    });
    expect(result.placeholderApp).toBe(true);
    expect(result.signed.length).toBeGreaterThan(0);
    expect(result.signed.every((s) => s.signed === false)).toBe(true);
  });

  it("package-ccx validates and zips a placeholder plugin, reporting the placeholder", async () => {
    const result = await runPackageCcx(ctx(), {
      pluginDir: config.ccx.pluginDir,
      minPremiereVersion: "25.6",
      version: "0.1.0",
    });
    expect(result.placeholderPlugin).toBe(true);
    expect(result.manifestValid).toBe(true);
  });

  it("sign-zxp packages a placeholder AE panel unsigned in dry-run", async () => {
    const result = await runSignZxp(ctx(), { pluginDir: config.zxp.pluginDir, version: "0.1.0" });
    expect(result.signed).toBe(false);
    expect(result.placeholderPlugin).toBe(true);
  });

  it("package-resolve zips a placeholder Resolve script bundle with installers", async () => {
    const result = await runPackageResolve(ctx(), config, "0.1.0");
    expect(result.placeholderPlugin).toBe(true);
    // C09: no config.resolvePanel in this fixture and no built plugins/resolve-panel/dist on
    // this test's repoRoot (a temp dir), so the panel is staged as a placeholder too.
    expect(result.placeholderPanel).toBe(true);
  });

  it("end to end: build -> checksums -> notarize -> publish alpha (no gate) -> promote to stable blocked before 24h, allowed after", async () => {
    const desktop = await runBuildDesktop(ctx(), config, {
      platform: "mac",
      channel: "alpha",
      dryRun: true,
    });
    await runChecksums(ctx(), "alpha");

    const artifactName = path.basename(desktop.artifactPath);
    await runNotarize(ctx(), { artifactPath: desktop.artifactPath, artifactName });

    const publishAlpha = await runPublish(ctx(), {
      channel: "alpha",
      version: "0.1.0",
      macArtifact: desktop.artifactPath,
    });
    expect(publishAlpha.uploaded).toHaveLength(1);
    expect(publishAlpha.feeds.length).toBeGreaterThan(0);

    // Not stable, so publish never checks the gate; promoting to stable before 24h must block.
    const tooSoon = await runPromote(ctx(), { from: "alpha", to: "stable", artifactName });
    expect(tooSoon.gate.allowed).toBe(false);
    expect(tooSoon.copied).toHaveLength(0);

    // 24h later it is allowed.
    now += 24 * 60 * 60 * 1000;
    const readyCtx = createContext({ repoRoot, outDir, mode: "dry-run", now: () => now });
    const onTime = await runPromote(readyCtx, { from: "alpha", to: "stable", artifactName });
    expect(onTime.gate.allowed).toBe(true);
    expect(onTime.copied.length).toBeGreaterThan(0);
  });

  it("--force with --reason overrides the 24h gate before it elapses", async () => {
    const desktop = await runBuildDesktop(ctx(), config, {
      platform: "mac",
      channel: "alpha",
      dryRun: true,
    });
    const artifactName = path.basename(desktop.artifactPath);
    await runNotarize(ctx(), { artifactPath: desktop.artifactPath, artifactName });
    await runPublish(ctx(), {
      channel: "alpha",
      version: "0.1.0",
      macArtifact: desktop.artifactPath,
    });

    const forced = await runPromote(ctx(), {
      from: "alpha",
      to: "stable",
      artifactName,
      force: true,
      reason: "hotfix",
    });
    expect(forced.gate.allowed).toBe(true);
    expect(forced.gate.reason).toMatch(/forced: hotfix/);
  });

  it("C10: publish writes plugins-manifest.json when ccx/resolve artifacts are given", async () => {
    const ccx = await runPackageCcx(ctx(), {
      pluginDir: config.ccx.pluginDir,
      minPremiereVersion: "25.6",
      version: "1.0.0",
    });
    const resolve = await runPackageResolve(ctx(), config, "1.0.0");
    const desktop = await runBuildDesktop(ctx(), config, {
      platform: "win",
      channel: "alpha",
      dryRun: true,
    });

    const publish = await runPublish(ctx(), {
      channel: "alpha",
      version: "1.0.0",
      winArtifact: desktop.artifactPath,
      ccxArtifact: { path: ccx.ccxPath, version: "1.0.0", minHostVersion: "25.6" },
      resolveArtifact: { path: resolve.bundlePath, version: "1.0.0" },
      domain: "aksharo.ai",
    });

    expect(publish.pluginManifestPath).toBeDefined();
    const raw = await readFile(publish.pluginManifestPath as string, "utf8");
    const manifest = JSON.parse(raw) as {
      channel: string;
      channels: Record<string, { version: string; downloadUrl: string } | undefined>;
      desktop?: { version: string; downloadUrl: { win: string | null } };
    };
    expect(manifest.channel).toBe("alpha");
    expect(manifest.channels["premiere-uxp"]?.version).toBe("1.0.0");
    expect(manifest.channels["premiere-uxp"]?.downloadUrl).toBe(
      `https://releases.aksharo.ai/releases/alpha/${path.basename(ccx.ccxPath)}`,
    );
    expect(manifest.channels["resolve-script"]?.version).toBe("1.0.0");
    expect(manifest.desktop?.version).toBe("1.0.0");
    expect(manifest.desktop?.downloadUrl.win).toContain("releases/alpha/");
  });

  it("verify-release detects a tampered artifact after publish", async () => {
    const desktop = await runBuildDesktop(ctx(), config, {
      platform: "win",
      channel: "beta",
      dryRun: true,
    });
    const publish = await runPublish(ctx(), {
      channel: "beta",
      version: "0.1.0",
      winArtifact: desktop.artifactPath,
    });
    // No CHECKSUMS.sha256 in the publish dir yet -> not ok.
    const beforeChecksums = await runVerifyRelease(ctx(), publish.destDir);
    expect(beforeChecksums.ok).toBe(false);
  });
});
