import { defineConfig, mergeConfig } from "vitest/config";

import { vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({ test: { name: "@montaj/timemap" } }),
);
