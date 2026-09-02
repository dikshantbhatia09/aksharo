/**
 * Single source of truth for release packaging (C00). Consumed by `tools/release`'s
 * `build-desktop`, `package-ccx`, `sign-zxp` and `package-resolve` commands, which generate
 * the electron-builder / UXP / ZXP / Resolve-bundle invocations from this data rather than
 * duplicating ids and paths in each command.
 *
 * Brand ids come from `packages/config/src/brand.ts` (CONTRACTS §0) — never hardcode them
 * here again.
 */
import { BRAND } from "./packages/config/src/brand";

import type { ReleaseConfig } from "./tools/release/src/config";

const config: ReleaseConfig = {
  appId: "ai.aksharo.desktop",
  productName: BRAND.name,
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
  // C09: Studio-only Workflow Integration panel. Paths are this WP's best guess at where
  // Resolve Studio's "Workflow Integration Plugins" folder lives (no confirmed doc found in
  // this repo, and C10's installer had not landed when this was written — flagged in the WP
  // report as needing a Gate C confirmation against a real Studio install).
  resolvePanel: {
    pluginDir: "plugins/resolve-panel",
    installPaths: {
      win: "%APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Workflow Integration Plugins",
      mac: "~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins",
      linux: "~/.local/share/DaVinciResolve/Workflow Integration Plugins",
    },
  },
  channels: ["alpha", "beta", "stable"],
};

export default config;
