import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 80, branches: 75 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/engine-client",
      coverage: { exclude: ["**/.tmp/**", "src/index.ts"] },
    },
  }),
);
