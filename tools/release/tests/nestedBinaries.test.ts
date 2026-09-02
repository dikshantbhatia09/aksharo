import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverNestedBinaries } from "../src/lib/nestedBinaries.js";

describe("discoverNestedBinaries", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "release-nested-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds mac nested binaries: mach-o, helper apps, engine, ffmpeg, bridge", async () => {
    const contents = path.join(dir, "Aksharo.app", "Contents");
    await mkdir(path.join(contents, "MacOS"), { recursive: true });
    await mkdir(path.join(contents, "Frameworks", "Aksharo Helper.app", "Contents", "MacOS"), {
      recursive: true,
    });
    await writeFile(path.join(contents, "MacOS", "Aksharo"), "x");
    await writeFile(
      path.join(
        contents,
        "Frameworks",
        "Aksharo Helper.app",
        "Contents",
        "MacOS",
        "Aksharo Helper",
      ),
      "x",
    );
    await writeFile(path.join(contents, "MacOS", "montaj-engine"), "x");
    await writeFile(path.join(contents, "MacOS", "ffmpeg"), "x");
    await writeFile(path.join(contents, "MacOS", "bridge"), "x");
    await writeFile(path.join(contents, "Frameworks", "libfoo.dylib"), "x");
    await mkdir(path.join(contents, "Resources"), { recursive: true });
    await writeFile(path.join(contents, "Resources", "icon.icns"), "x");

    const targets = await discoverNestedBinaries(dir, "mac");
    const names = targets.map((t) => path.basename(t.path)).sort();

    expect(names).toContain("Aksharo");
    expect(names).toContain("Aksharo Helper");
    expect(names).toContain("montaj-engine");
    expect(names).toContain("ffmpeg");
    expect(names).toContain("bridge");
    expect(names).toContain("libfoo.dylib");
    expect(names).not.toContain("icon.icns");
    expect(targets.every((t) => t.platform === "mac")).toBe(true);
  });

  it("finds win nested binaries: exe and dll only", async () => {
    const unpacked = path.join(dir, "win-unpacked");
    await mkdir(unpacked, { recursive: true });
    await writeFile(path.join(unpacked, "Aksharo.exe"), "x");
    await writeFile(path.join(unpacked, "montaj-engine.exe"), "x");
    await writeFile(path.join(unpacked, "resources.dll"), "x");
    await writeFile(path.join(unpacked, "resources.pak"), "x");

    const targets = await discoverNestedBinaries(dir, "win");
    const names = targets.map((t) => path.basename(t.path)).sort();

    expect(names).toEqual(["Aksharo.exe", "montaj-engine.exe", "resources.dll"]);
    expect(targets.find((t) => t.path.endsWith(".exe"))?.kind).toBe("pe-exe");
    expect(targets.find((t) => t.path.endsWith(".dll"))?.kind).toBe("pe-dll");
  });

  it("returns an empty array for a missing directory", async () => {
    const targets = await discoverNestedBinaries(path.join(dir, "does-not-exist"), "mac");
    expect(targets).toEqual([]);
  });
});
