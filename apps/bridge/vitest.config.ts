import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9: treated as an `apps/*`-tier package (75/70); `main.ts` itself
// (process wiring, env reads, signal handlers) is excluded from the threshold
// because it is exercised by the SEA smoke test, not unit tests.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 75, branches: 70 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/bridge",
      coverage: { exclude: ["**/.tmp/**", "src/main.ts"] },
    },
  }),
);
