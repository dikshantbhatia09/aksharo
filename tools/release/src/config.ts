import path from "node:path";

import { releaseMode } from "./env.js";

import type { ReleaseContext, ReleaseMode } from "./types.js";

/** Repo root is three levels up from this file's directory (tools/release/src -> repo). */
export function resolveRepoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

export function createContext(overrides: Partial<ReleaseContext> = {}): ReleaseContext {
  const repoRoot = overrides.repoRoot ?? resolveRepoRoot();
  const mode: ReleaseMode = overrides.mode ?? releaseMode();
  return {
    repoRoot,
    outDir: overrides.outDir ?? path.join(repoRoot, ".release"),
    mode,
    now: overrides.now ?? (() => Date.now()),
  };
}

/**
 * Single config every electron-builder invocation is generated from (brief: "wraps
 * electron-builder config generated from a single `release.config.ts`"). Kept as plain data
 * (not electron-builder's own types) so this package has no hard dependency on
 * `electron-builder` — C02 owns the actual electron-builder devDependency in `apps/desktop`.
 */
export interface ReleaseConfig {
  appId: string;
  productName: string;
  desktopAppDir: string;
  mac: { target: ("dmg" | "zip" | "pkg")[]; category: string };
  win: { target: "nsis"; arch: "x64" };
  ccx: { pluginDir: string; minPremiereVersion: string };
  zxp: { pluginDir: string };
  resolveBundle: { scriptDir: string; installPaths: Record<"win" | "mac" | "linux", string> };
  channels: readonly ["alpha", "beta", "stable"];
}

export async function loadReleaseConfig(repoRoot: string): Promise<ReleaseConfig> {
  const configPath = path.join(repoRoot, "release.config.ts");
  const mod = (await import(pathToFileUrl(configPath))) as { default: ReleaseConfig };
  return mod.default;
}

function pathToFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}
