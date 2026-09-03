import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9: "each WP that creates a package adds its threshold." This package is pure
// plan-building/mapping logic (no host, no I/O) shared by two plugin runtimes, so it is held to
// the same 90/85 bar as packages/edg and packages/timemap, not the lighter plugin-adapter bar.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/shared-apply",
      coverage: {
        // `types.ts` is interfaces/type-aliases only (compiles to `export {}`), which v8 counts
        // as uncovered lines even though there is no executable code — same exclusion rationale
        // as `packages/timemap`'s `src/query.ts`.
        exclude: ["**/.tmp/**", "scripts/**", "src/types.ts"],
      },
    },
  }),
);
