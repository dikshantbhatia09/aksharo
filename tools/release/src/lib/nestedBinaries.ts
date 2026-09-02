import path from "node:path";

import { walkFiles } from "./fsUtil.js";

import type { Platform, SignTarget } from "../types.js";

const MACHO_EXT = new Set([".dylib", ".node", ".so"]);
const PE_EXE_EXT = new Set([".exe"]);
const PE_DLL_EXT = new Set([".dll"]);
/** Names with no extension that are still executables inside a mac `.app` bundle. */
const MACHO_NO_EXT_HINTS = [
  "helper",
  "engine",
  "ffmpeg",
  "bridge",
  "updater",
  "montaj-engine",
  "aksharo",
];

/**
 * Walks a built app tree (mac `.app` bundle contents, or a Windows `win-unpacked` dir) and
 * returns every binary that must be individually signed: the main executable, Electron
 * helper apps, native `.node` addons, the engine sidecar, ffmpeg, the bridge SEA binary and
 * the updater — matches RR-07 "every executable including nested binaries ... signed
 * individually".
 */
export async function discoverNestedBinaries(
  appRoot: string,
  platform: Platform,
): Promise<SignTarget[]> {
  const files = await walkFiles(appRoot);
  const targets: SignTarget[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file).toLowerCase();

    if (platform === "mac") {
      if (MACHO_EXT.has(ext)) {
        targets.push({ path: file, platform, kind: "mach-o" });
        continue;
      }
      const looksExecutableNoExt =
        ext === "" && MACHO_NO_EXT_HINTS.some((hint) => base.includes(hint));
      if (looksExecutableNoExt) {
        targets.push({ path: file, platform, kind: "mach-o" });
      }
    } else {
      if (PE_EXE_EXT.has(ext)) {
        targets.push({ path: file, platform, kind: "pe-exe" });
      } else if (PE_DLL_EXT.has(ext)) {
        targets.push({ path: file, platform, kind: "pe-dll" });
      }
    }
  }

  return targets.sort((a, b) => a.path.localeCompare(b.path));
}

/** The mac `.app` bundle itself must be signed last, deep, after every nested binary. */
export function outermostBundleTarget(appBundlePath: string, platform: Platform): SignTarget {
  return { path: appBundlePath, platform, kind: "app-bundle" };
}
