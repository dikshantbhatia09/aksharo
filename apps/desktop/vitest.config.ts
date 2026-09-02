import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

const withSettings = mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({
    test: {
      name: "@montaj/desktop",
      root: "./",
    },
  }),
);

// New package (CONTRACTS §9 asks each WP that creates a package to set a
// threshold); desktop's testable surface is the pure allowlist / deep-link /
// updater-feed logic — main/preload wiring itself needs a real Electron
// runtime and is covered by the Playwright-Electron smoke suite instead.
export default mergeConfig(
  withSettings,
  defineConfig(coverageThresholds({ lines: 80, branches: 75 })),
);
