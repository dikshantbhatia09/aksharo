import { defineConfig, mergeConfig } from "vitest/config";

import { vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({
    test: {
      name: "@montaj/web",
      // `e2e/` belongs to Playwright, not Vitest.
      include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
    },
  }),
);
