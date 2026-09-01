import swc from "unplugin-swc";
import { defineConfig, mergeConfig } from "vitest/config";

import { vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({
    // NestJS DI reads `design:paramtypes`, which esbuild cannot emit; SWC can.
    plugins: [swc.vite({ module: { type: "es6" } })],
    test: {
      name: "@montaj/api",
      root: "./",
      include: ["src/**/*.test.ts", "test/**/*.e2e-spec.ts"],
      setupFiles: ["./test/setup-env.ts"],
    },
  }),
);
