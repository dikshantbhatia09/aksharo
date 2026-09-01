import { defineConfig, mergeConfig } from "vitest/config";

import { vitestBaseConfig } from "./vitest.base.mjs";

export default mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({ test: { name: "@montaj/config" } }),
);
