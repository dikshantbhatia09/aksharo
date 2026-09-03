import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    // New package (CONTRACTS §9: "each WP that creates a package adds its threshold"). Starts
    // at the `apps/web` UI gate (60/50) since this is UI + adapter code, not core business logic.
    defineConfig(coverageThresholds({ lines: 60, branches: 50 })),
  ),
  defineConfig({
    esbuild: { jsx: "automatic" },
    test: {
      name: "@montaj/premiere-uxp",
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}", "mogrt/**/*.{test,spec}.{ts,tsx}"],
      coverage: {
        include: ["src/**/*.{ts,tsx}", "mogrt/**/*.ts"],
        exclude: [
          "src/index.tsx",
          "src/**/*.test.{ts,tsx}",
          "mogrt/**/*.test.ts",
          "mogrt/build-placeholder.ts",
          "mogrt/verify-cli.ts",
        ],
      },
    },
  }),
);
