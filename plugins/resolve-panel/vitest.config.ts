import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    // New package (CONTRACTS §9: "each WP that creates a package adds its threshold"). Same
    // gate as the C05a UXP panel (60/50, `apps/web`'s UI tier) — this is UI + adapter code.
    defineConfig(coverageThresholds({ lines: 60, branches: 50 })),
  ),
  defineConfig({
    esbuild: { jsx: "automatic" },
    test: {
      name: "@montaj/resolve-panel",
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      coverage: {
        include: ["src/**/*.{ts,tsx}"],
        // wsTransport.ts is the one file allowed to construct a real browser `WebSocket`
        // (mirrors src/index.tsx's production-only wiring); it is exercised manually per
        // docs/GATE-C-CHECKLIST.md, not by jsdom, which has no real WebSocket server to talk to.
        exclude: ["src/index.tsx", "src/rpc/wsTransport.ts", "src/**/*.test.{ts,tsx}"],
      },
    },
  }),
);
