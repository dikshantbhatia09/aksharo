import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9: packages/caption-styles is a 90/85 package.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
  ),
  defineConfig({ test: { name: "@montaj/caption-styles", coverage: { exclude: ["**/.tmp/**"] } } }),
);
