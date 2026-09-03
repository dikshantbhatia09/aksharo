import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateBearerToken, readDiscoveryFile, writeDiscoveryFile } from "./discovery.js";

describe("discovery file", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("round-trips and is mode 0600 on POSIX", () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-discovery-"));
    const path = join(dir, "bridge.json");
    const file = {
      port: 47831,
      certFingerprint: "deadbeef",
      bearer: generateBearerToken(),
      pid: process.pid,
      version: "1",
      startedAt: new Date().toISOString(),
    };
    writeDiscoveryFile(file, path);

    const read = readDiscoveryFile(path);
    expect(read).toEqual(file);

    if (process.platform !== "win32") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("returns undefined for a missing file", () => {
    expect(readDiscoveryFile(join(tmpdir(), "no-such-bridge-file.json"))).toBeUndefined();
  });

  it("returns undefined for a malformed file", () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-discovery-bad-"));
    const path = join(dir, "bridge.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(path, "not json");
    expect(readDiscoveryFile(path)).toBeUndefined();
  });
});

describe("generateBearerToken", () => {
  it("produces distinct high-entropy tokens", () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
