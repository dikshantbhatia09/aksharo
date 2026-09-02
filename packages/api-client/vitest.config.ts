import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    // Client-layer code that every surface depends on; A13 set the row at the
    // service tier of CONTRACTS §9 rather than the UI tier.
    defineConfig(coverageThresholds({ lines: 75, branches: 70 })),
  ),
  defineConfig({
    esbuild: { jsx: "automatic" },
    test: {
      name: "@montaj/api-client",
      // `SessionStore`, the fetch layer and the realtime client all touch browser
      // globals (`atob`, `Response`, `DOMException`), so the suite runs in jsdom.
      environment: "jsdom",
      coverage: {
        include: ["src/**/*.ts"],
        exclude: [
          "src/index.ts",
          "src/generated/**",
          "src/**/*.test.ts",
          "src/context.ts",
          "src/hooks.ts",
        ],
      },
    },
  }),
);
