import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    // New package (CONTRACTS §9: "each WP that creates a package adds its threshold"). Starts
    // at the `apps/web` UI gate (60/50), same as `@montaj/premiere-uxp` (C05a) — this is UI +
    // adapter code, not core business logic.
    defineConfig(coverageThresholds({ lines: 60, branches: 50 })),
  ),
  defineConfig({
    esbuild: { jsx: "automatic" },
    test: {
      name: "@montaj/ae-cep",
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["src/jsx/**"],
      coverage: {
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/index.tsx", "src/**/*.test.{ts,tsx}", "src/jsx/**"],
      },
    },
  }),
);
