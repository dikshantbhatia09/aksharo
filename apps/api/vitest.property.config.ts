import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * `pnpm --filter @montaj/api test:property` — the credits ledger concurrency
 * property test (brief §8, the DoD), run separately from `pnpm test`.
 *
 * A dedicated config, not an addition to `vitest.config.ts`'s `include`, on
 * purpose: `credits-ledger.property.spec.ts` runs 2,000 operations across 50
 * concurrent workers against a real Postgres and can take minutes, which has no
 * business gating every `pnpm --filter @montaj/api test` run the way the rest
 * of the suite does.
 *
 * Deliberately NOT built on `mergeConfig(vitestBaseConfig, …)`: Vitest's
 * `mergeConfig` concatenates array fields rather than replacing them, so
 * merging in `@montaj/config/vitest`'s `include` (`src/**\/*.{test,spec}.ts`)
 * would run every unit test here too instead of replacing it with this file's
 * own `include`. This config lists what it actually needs instead.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    name: "@montaj/api:property",
    root: "./",
    globals: false,
    environment: "node",
    include: ["test/**/*.property.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
    setupFiles: ["./test/setup-env.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // One property run drives 2,000 operations in batches of 50 against a real
    // database; generous but bounded so a genuine hang still fails CI.
    testTimeout: 10 * 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 180_000,
    // The whole point is real concurrency inside the test; running two
    // property files in parallel on top of that would only make failures
    // harder to read for no coverage gain (there is one file today).
    fileParallelism: false,
  },
});
