import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9: treated as an `apps/*`-tier package (75/70); `main.ts` (process
// wiring, env reads, signal handlers) is excluded, same rationale as apps/bridge.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 75, branches: 70 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/engine",
      maxWorkers: 2,
      coverage: { exclude: ["**/.tmp/**", "src/main.ts"] },
    },
  }),
);
