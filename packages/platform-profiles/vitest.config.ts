import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({ test: { name: "@montaj/platform-profiles" } }),
  ),
  defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
);
