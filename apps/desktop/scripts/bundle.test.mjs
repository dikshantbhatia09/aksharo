import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXTERNALS, bundleEntry, writeDistPackageJson } from "./bundle.mjs";

/**
 * C00b brief §5: bundle script unit test (externals list, output files).
 * Exercises esbuild against small hermetic fixtures rather than the real
 * `src/main`/`src/preload` entry points, so it never depends on
 * `@montaj/bridge-core`/`@montaj/config` already being built.
 */
describe("bundle.mjs", () => {
  it("externalizes only electron; Node built-ins are external automatically (platform: node)", () => {
    expect(EXTERNALS).toEqual(["electron"]);
  });

  let tmp;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "desktop-bundle-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("inlines a workspace-style local import and leaves `electron` as an external require", async () => {
    const helperPath = path.join(tmp, "helper.ts");
    await writeFile(
      helperPath,
      "export function helperValue(): string { return 'inlined-helper'; }\n",
      "utf8",
    );
    const entryPath = path.join(tmp, "entry.ts");
    await writeFile(
      entryPath,
      [
        "import { app } from 'electron';",
        "import { helperValue } from './helper.js';",
        "console.log(app, helperValue());",
      ].join("\n"),
      "utf8",
    );
    const outPath = path.join(tmp, "out", "entry.js");

    await bundleEntry({ in: entryPath, out: outPath });

    const bundled = await readFile(outPath, "utf8");
    expect(bundled).toContain("inlined-helper");
    expect(bundled).not.toContain("./helper.js");
    expect(bundled).toMatch(/require\(["']electron["']\)/);
  });

  it("writes a dependency-free dist/package.json carrying only name/version/main", async () => {
    const appDir = path.join(tmp, "app");
    const distDir = path.join(tmp, "app", "dist");
    await mkdir(appDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({
        name: "@montaj/desktop",
        version: "1.2.3",
        dependencies: { "@montaj/bridge-core": "workspace:*" },
      }),
      "utf8",
    );

    const distPkg = await writeDistPackageJson(appDir, distDir);

    expect(distPkg).toEqual({
      name: "@montaj/desktop",
      version: "1.2.3",
      private: true,
      main: "main/index.js",
    });
    expect(distPkg.dependencies).toBeUndefined();

    const written = JSON.parse(await readFile(path.join(distDir, "package.json"), "utf8"));
    expect(written).toEqual(distPkg);
  });
});
