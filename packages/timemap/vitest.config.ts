import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9: packages/timemap is a 90/85 package.
//
// Two exclusions, both of files with no executable code: `src/query.ts` is
// interfaces only (it compiles to `export {}`, which v8 counts as 53 uncovered
// lines) and the ESM build marker is exercised by running the build, not by unit
// tests. Everything with behaviour in it is measured.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/timemap",
      coverage: {
        exclude: ["**/.tmp/**", "src/query.ts", "scripts/finalise-esm-build.mjs"],
      },
    },
  }),
);
