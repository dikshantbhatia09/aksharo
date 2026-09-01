import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9: packages/edg is a 90/85 package. Build tooling (the JSON Schema
// generator and the ESM marker) is excluded — it is exercised by running the
// build, not by unit tests; `scripts/schema-files.ts` stays in because the
// "schemas are up to date" test drives it. `src/testing.ts` is the fixture
// builder the suites share and is not shipped.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/edg",
      coverage: {
        exclude: [
          "**/.tmp/**",
          "src/testing.ts",
          "scripts/generate-json-schemas.ts",
          "scripts/build-segmenter-golden.ts",
          "scripts/finalise-esm-build.mjs",
        ],
      },
    },
  }),
);
