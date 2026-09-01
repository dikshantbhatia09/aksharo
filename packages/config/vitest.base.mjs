/**
 * Shared Vitest preset. Consume from a package with:
 *
 *   import { defineConfig, mergeConfig } from "vitest/config";
 *   import { vitestBaseConfig } from "@montaj/config/vitest";
 *   export default mergeConfig(vitestBaseConfig, defineConfig({ test: { name: "@montaj/edg" } }));
 *
 * `coverageThresholds()` produces the per-package coverage gate referenced by
 * docs/CONTRACTS.md §9; packages raise the numbers as they gain real code.
 */

/** @type {import("vitest/config").UserConfig} */
export const vitestBaseConfig = {
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/e2e/**"],
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: process.env.CI ? { junit: "./coverage/junit.xml" } : undefined,
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text-summary", "lcov"],
      exclude: ["**/dist/**", "**/*.test.ts", "**/*.config.*", "**/index.ts"],
    },
  },
};

/**
 * @param {{ lines?: number; functions?: number; branches?: number; statements?: number }} thresholds
 * @returns {import("vitest/config").UserConfig}
 */
export function coverageThresholds(thresholds) {
  return { test: { coverage: { thresholds } } };
}

export default vitestBaseConfig;
