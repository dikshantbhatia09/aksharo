import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    // CONTRACTS §9 fixes 60/50 for UI code (`apps/web`); this package is the same
    // kind of code, so it carries the same gate. A13 added the row.
    defineConfig(coverageThresholds({ lines: 60, branches: 50 })),
  ),
  defineConfig({
    // Vitest transforms TSX with esbuild; the automatic runtime keeps the test
    // files free of a React import and matches what Next emits.
    esbuild: { jsx: "automatic" },
    test: {
      name: "@montaj/ui",
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      coverage: {
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/index.ts", "src/**/*.test.{ts,tsx}"],
      },
    },
  }),
);
