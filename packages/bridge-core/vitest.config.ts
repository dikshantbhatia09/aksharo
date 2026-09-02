import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

// CONTRACTS §9 does not list bridge-core explicitly (added by C01); treated as an
// `apps/*`-tier package (75/70) rather than a math/schema package (90/85) because
// most of its surface is I/O (sockets, files, certs) exercised through integration
// style tests rather than pure functions.
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig(coverageThresholds({ lines: 75, branches: 70 })),
  ),
  defineConfig({
    test: {
      name: "@montaj/bridge-core",
      testTimeout: 15_000,
    },
  }),
);
