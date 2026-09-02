import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildChecksumManifest,
  manifestBody,
  writeSignedChecksums,
} from "../src/lib/checksumManifest.js";

describe("checksum manifest round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "release-checksums-"));
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "a.zip"), "hello");
    await writeFile(path.join(dir, "sub", "b.zip"), "world");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes every file deterministically and excludes its own manifest files", async () => {
    const entries = await buildChecksumManifest(dir);
    expect(entries.map((e) => e.file).sort()).toEqual(["a.zip", "sub/b.zip"]);
    expect(entries.every((e) => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(true);
  });

  it("manifestBody is stable and re-parseable", async () => {
    const entries = await buildChecksumManifest(dir);
    const body = manifestBody(entries);
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^[a-f0-9]{64} {2}\S+$/);
    }
  });

  it("writeSignedChecksums produces an UNSIGNED marker without a key, and no marker with one", async () => {
    const { manifestPath, signaturePath } = await writeSignedChecksums(dir, undefined);
    const sig = await readFile(signaturePath, "utf8");
    expect(sig).toMatch(/^# UNSIGNED/);
    const manifest = await readFile(manifestPath, "utf8");
    expect(manifest.split("\n").filter(Boolean)).toHaveLength(2);

    const signedResult = await writeSignedChecksums(
      dir,
      Buffer.from("a-real-key").toString("base64"),
    );
    const signedSig = await readFile(signedResult.signaturePath, "utf8");
    expect(signedSig).not.toMatch(/UNSIGNED/);
    expect(signedSig).toMatch(/^hmac-sha256/);
  });

  it("re-hashing after writing CHECKSUMS.sha256 still matches (self-exclusion)", async () => {
    await writeSignedChecksums(dir, undefined);
    const entries = await buildChecksumManifest(dir);
    expect(entries.map((e) => e.file).sort()).toEqual(["a.zip", "sub/b.zip"]);
  });
});
