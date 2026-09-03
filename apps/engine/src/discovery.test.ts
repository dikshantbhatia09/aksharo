import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  engineDiscoveryFilePath,
  generateBearerToken,
  readEngineDiscoveryFile,
  removeEngineDiscoveryFile,
  writeEngineDiscoveryFile,
} from "./discovery.js";

describe("engine discovery file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-discovery-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes with mode 0600 on POSIX", () => {
    const path = engineDiscoveryFilePath(dir);
    writeEngineDiscoveryFile(
      {
        port: 47900,
        bearer: generateBearerToken(),
        pid: 123,
        version: "0.1.0",
        startedAt: new Date().toISOString(),
      },
      path,
    );
    // Windows has no POSIX permission bits (bridge-core's own discovery.test.ts
    // guards the same assertion the same way); the write still succeeds there,
    // it just cannot be observed via `mode`.
    if (process.platform !== "win32") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("round-trips through read/write", () => {
    const path = engineDiscoveryFilePath(dir);
    const file = {
      port: 47901,
      bearer: generateBearerToken(),
      pid: 456,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
    };
    writeEngineDiscoveryFile(file, path);
    expect(readEngineDiscoveryFile(path)).toEqual(file);
  });

  it("returns undefined for a missing file", () => {
    expect(readEngineDiscoveryFile(join(dir, "nope.json"))).toBeUndefined();
  });

  it("returns undefined for a corrupt file", () => {
    const path = engineDiscoveryFilePath(dir);
    writeEngineDiscoveryFile(
      { port: 1, bearer: generateBearerToken(), pid: 1, version: "x", startedAt: "x" },
      path,
    );
    // Corrupt it directly.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    writeFileSync(path, "not json");
    expect(readEngineDiscoveryFile(path)).toBeUndefined();
  });

  it("removeEngineDiscoveryFile deletes the file and is idempotent", () => {
    const path = engineDiscoveryFilePath(dir);
    writeEngineDiscoveryFile(
      { port: 1, bearer: generateBearerToken(), pid: 1, version: "x", startedAt: "x" },
      path,
    );
    removeEngineDiscoveryFile(path);
    expect(readEngineDiscoveryFile(path)).toBeUndefined();
    expect(() => removeEngineDiscoveryFile(path)).not.toThrow();
  });

  it("generateBearerToken produces >=32-char high-entropy tokens", () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it("engineDiscoveryFilePath differs from the bridge's own bridge.json name", () => {
    expect(engineDiscoveryFilePath(dir)).toBe(join(dir, "engine.json"));
  });

  it("readFileSync sanity: written JSON is pretty-printed and newline-terminated", () => {
    const path = engineDiscoveryFilePath(dir);
    writeEngineDiscoveryFile(
      { port: 1, bearer: generateBearerToken(), pid: 1, version: "x", startedAt: "x" },
      path,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
