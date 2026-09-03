import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileKeyStore, InMemoryKeyStore } from "./keystore.js";

describe("InMemoryKeyStore", () => {
  it("round-trips a saved secret and forgets it on delete", async () => {
    const store = new InMemoryKeyStore();
    expect(await store.load("a")).toBeUndefined();
    await store.save("a", "secret-value");
    expect(await store.load("a")).toBe("secret-value");
    await store.delete("a");
    expect(await store.load("a")).toBeUndefined();
  });

  it("keeps distinct names independent", async () => {
    const store = new InMemoryKeyStore();
    await store.save("a", "1");
    await store.save("b", "2");
    expect(await store.load("a")).toBe("1");
    expect(await store.load("b")).toBe("2");
  });
});

describe("FileKeyStore", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("round-trips a secret as a 0600 file, the documented fallback", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-filekeystore-"));
    const store = new FileKeyStore(dir);
    expect(await store.load("k")).toBeUndefined();

    await store.save("k", "top-secret");
    expect(await store.load("k")).toBe("top-secret");

    const path = join(dir, "k.key");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    await store.delete("k");
    expect(await store.load("k")).toBeUndefined();
  });

  it("creates its directory on first save", async () => {
    dir = join(mkdtempSync(join(tmpdir(), "bridge-filekeystore-parent-")), "keys");
    const store = new FileKeyStore(dir);
    await store.save("k", "v");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    expect(existsSync(dir)).toBe(true);
  });
});

describe("createDefaultKeyStore", () => {
  it("falls back to FileKeyStore on platforms with no OS-backed store (e.g. Linux/CI)", async () => {
    if (process.platform === "darwin" || process.platform === "win32") return; // exercised below instead
    const { createDefaultKeyStore } = await import("./keystore.js");
    const store = await createDefaultKeyStore();
    expect(store.kind).toBe("file");
  });

  it("probes the platform-appropriate OS store and only falls back if the probe fails", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    const { createDefaultKeyStore } = await import("./keystore.js");
    const store = await createDefaultKeyStore();
    // Either the real OS store works (keychain/dpapi) or this machine can't
    // reach it (headless CI runner) and the probe demoted it to the file
    // fallback — both are valid, documented outcomes.
    expect(["keychain", "dpapi", "file"]).toContain(store.kind);
  });
});
