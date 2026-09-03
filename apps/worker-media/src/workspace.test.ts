import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { withWorkspace } from "./workspace.js";

describe("withWorkspace", () => {
  it("gives the job a fresh directory and removes it afterwards", async () => {
    let seen = "";
    await withWorkspace("test", undefined, async (workspace) => {
      seen = workspace.dir;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      expect(existsSync(workspace.dir)).toBe(true);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      await writeFile(workspace.path("a.txt"), "x");
      expect(await workspace.size("a.txt")).toBe(1);
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    expect(existsSync(seen)).toBe(false);
  });

  it("removes the directory when the job throws", async () => {
    // A worker that leaks one directory per FAILED job fills its disk in a day,
    // and failing jobs are exactly the ones that repeat.
    let seen = "";
    await expect(
      withWorkspace("test", undefined, async (workspace) => {
        seen = workspace.dir;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
        await writeFile(workspace.path("half-written.mp4"), "partial");
        throw new Error("encode died");
      }),
    ).rejects.toThrow("encode died");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    expect(existsSync(seen)).toBe(false);
  });

  it("gives two concurrent jobs two different directories", async () => {
    const [first, second] = await Promise.all([
      withWorkspace("test", undefined, async (workspace) => workspace.dir),
      withWorkspace("test", undefined, async (workspace) => workspace.dir),
    ]);
    expect(first).not.toBe(second);
  });

  it("returns whatever the job returned", async () => {
    expect(await withWorkspace("test", undefined, async () => 42)).toBe(42);
  });
});
