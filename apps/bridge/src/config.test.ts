import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bridge app config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-app-config-"));
    vi.resetModules();
    vi.doMock("@montaj/bridge-core", () => ({ aksharoDir: () => dir }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("@montaj/bridge-core");
  });

  it("returns {} when no config file exists", async () => {
    const { loadConfig } = await import("./config.js");
    expect(loadConfig()).toEqual({});
  });

  it("round-trips a saved config", async () => {
    const { loadConfig, saveConfig } = await import("./config.js");
    saveConfig({ deviceToken: "dt", relayUrl: "wss://x", autostart: true });
    expect(loadConfig()).toEqual({ deviceToken: "dt", relayUrl: "wss://x", autostart: true });
  });

  it("returns {} for a malformed config file", async () => {
    const { loadConfig, saveConfig } = await import("./config.js");
    saveConfig({ deviceToken: "dt" });
    const fs = await import("node:fs");
    fs.writeFileSync(join(dir, "config.json"), "not json");
    expect(loadConfig()).toEqual({});
  });
});
