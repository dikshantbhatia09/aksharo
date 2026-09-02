import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({
    test: {
      name: "@montaj/release",
      include: ["tests/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
      coverage: coverageThresholds({ lines: 75, functions: 75, branches: 70, statements: 75 }).test
        .coverage,
    },
  }),
);
