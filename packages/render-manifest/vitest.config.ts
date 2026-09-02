import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9 has no row for this package yet; it is a pure schema-and-crypto
// package with no I/O, so it is held to the 90/85 bar every other `packages/*`
// entry in that table carries.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({ test: { name: "@montaj/render-manifest" } }),
  ),
  defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
);
