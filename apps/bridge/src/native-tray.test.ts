import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeTray } from "./native-tray.js";

import type { SysTrayFactory, SysTrayLike } from "./native-tray.js";

/** A fake `systray2` instance driven directly by the test. */
function fakeSysTray(): SysTrayLike & { emitClick: (id: string) => void } {
  let clickListener: ((action: { item: { title: string; __id?: string } }) => void) | undefined;
  return {
    onReady: () => undefined,
    onClick: (listener) => {
      clickListener = listener as never;
      return Promise.resolve();
    },
    onError: () => undefined,
    onExit: () => undefined,
    sendAction: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    ready: () => Promise.resolve(),
    emitClick(id: string) {
      clickListener?.({ item: { title: id, __id: id } });
    },
  };
}

describe("createNativeTray", () => {
  it("resolves undefined on Linux with no DISPLAY (documented headless fallback)", async () => {
    if (process.platform !== "linux") return; // platform-specific guard, exercised only on Linux CI
    const original = process.env["DISPLAY"];
    delete process.env["DISPLAY"];
    try {
      const tray = await createNativeTray({ factory: () => fakeSysTray() });
      expect(tray).toBeUndefined();
    } finally {
      if (original !== undefined) process.env["DISPLAY"] = original;
    }
  });

  it("resolves undefined and never throws when the factory itself throws", async () => {
    const tray = await createNativeTray({
      factory: () => {
        throw new Error("no display server");
      },
    });
    expect(tray).toBeUndefined();
  });

  it("resolves a TrayController that resolves requestApproval on an approve click", async () => {
    if (process.platform === "linux" && process.env["DISPLAY"] === undefined) return;
    const fake = fakeSysTray();
    const tray = await createNativeTray({ factory: () => fake });
    expect(tray).toBeDefined();
    if (tray === undefined) return;

    const approvalPromise = tray.requestApproval({
      pairingId: "p1",
      clientKind: "premiere",
      clientName: "Premiere",
      scopes: [],
      code: "ABCD1234",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: "pending",
    });
    fake.emitClick("approve");
    await expect(approvalPromise).resolves.toBe("approved");
  });

  it("resolves 'denied' on a deny click", async () => {
    if (process.platform === "linux" && process.env["DISPLAY"] === undefined) return;
    const fake = fakeSysTray();
    const tray = await createNativeTray({ factory: () => fake });
    if (tray === undefined) return;

    const approvalPromise = tray.requestApproval({
      pairingId: "p2",
      clientKind: "ae",
      clientName: "After Effects",
      scopes: [],
      code: "EFGH5678",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: "pending",
    });
    fake.emitClick("deny");
    await expect(approvalPromise).resolves.toBe("denied");
  });

  it("invokes onQuitRequested listeners on a quit click", async () => {
    if (process.platform === "linux" && process.env["DISPLAY"] === undefined) return;
    const fake = fakeSysTray();
    const tray = await createNativeTray({ factory: () => fake });
    if (tray === undefined) return;

    const onQuit = vi.fn();
    tray.onQuitRequested(onQuit);
    fake.emitClick("quit");
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it("closes cleanly via close()", async () => {
    if (process.platform === "linux" && process.env["DISPLAY"] === undefined) return;
    const fake = fakeSysTray();
    const kill = vi.spyOn(fake, "kill");
    const tray = await createNativeTray({ factory: () => fake });
    if (tray === undefined) return;
    await tray.close();
    expect(kill).toHaveBeenCalledWith(false);
  });

  it("resolves undefined when the injected factory's ready() rejects", async () => {
    if (process.platform === "linux" && process.env["DISPLAY"] === undefined) return;
    const fake = fakeSysTray();
    fake.ready = () => Promise.reject(new Error("helper crashed"));
    const factory: SysTrayFactory = () => fake;
    const tray = await createNativeTray({ factory });
    expect(tray).toBeUndefined();
  });
});

describe("createNativeTray — opt-in gate (AKSHARO_BRIDGE_TRAY)", () => {
  const originalFlag = process.env["AKSHARO_BRIDGE_TRAY"];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    if (originalFlag === undefined) delete process.env["AKSHARO_BRIDGE_TRAY"];
    else process.env["AKSHARO_BRIDGE_TRAY"] = originalFlag;
  });

  it("resolves undefined by default, without ever touching the helper-binary check", async () => {
    delete process.env["AKSHARO_BRIDGE_TRAY"];
    vi.resetModules();
    // If the opt-in gate did not short-circuit first, this mock would make
    // the helper-binary check throw (existsSync is not a function).
    vi.doMock("node:fs", () => ({}));
    const { createNativeTray: freshCreateNativeTray } = await import("./native-tray.js");
    const tray = await freshCreateNativeTray({});
    expect(tray).toBeUndefined();
  });

  it('resolves undefined for any value other than the literal string "native"', async () => {
    process.env["AKSHARO_BRIDGE_TRAY"] = "1";
    vi.resetModules();
    const { createNativeTray: freshCreateNativeTray } = await import("./native-tray.js");
    const tray = await freshCreateNativeTray({});
    expect(tray).toBeUndefined();
  });

  it("does not gate test injection via options.factory", async () => {
    delete process.env["AKSHARO_BRIDGE_TRAY"];
    const tray = await createNativeTray({ factory: () => fakeSysTray() });
    expect(tray).toBeDefined();
    await tray?.close();
  });
});

describe("createNativeTray — no injected factory (real wiring paths, AKSHARO_BRIDGE_TRAY=native)", () => {
  const originalCi = process.env["CI"];
  const originalFlag = process.env["AKSHARO_BRIDGE_TRAY"];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    if (originalCi === undefined) delete process.env["CI"];
    else process.env["CI"] = originalCi;
    if (originalFlag === undefined) delete process.env["AKSHARO_BRIDGE_TRAY"];
    else process.env["AKSHARO_BRIDGE_TRAY"] = originalFlag;
  });

  it("still skips under CI even with the opt-in flag set (defense-in-depth)", async () => {
    process.env["AKSHARO_BRIDGE_TRAY"] = "native";
    process.env["CI"] = "true";
    const { createNativeTray: freshCreateNativeTray } = await import("./native-tray.js");
    const tray = await freshCreateNativeTray({});
    expect(tray).toBeUndefined();
  });

  it("resolves undefined when no traybin directory exists (packaged build missing dist/traybin)", async () => {
    process.env["AKSHARO_BRIDGE_TRAY"] = "native";
    delete process.env["CI"];
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    const { createNativeTray: freshCreateNativeTray } = await import("./native-tray.js");
    const tray = await freshCreateNativeTray({});
    expect(tray).toBeUndefined();
  });
});

describe("createNativeTray — real systray2 import path (mocked, AKSHARO_BRIDGE_TRAY=native)", () => {
  const originalFlag = process.env["AKSHARO_BRIDGE_TRAY"];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("systray2");
    vi.resetModules();
    delete process.env["CI"];
    if (originalFlag === undefined) delete process.env["AKSHARO_BRIDGE_TRAY"];
    else process.env["AKSHARO_BRIDGE_TRAY"] = originalFlag;
  });

  it("constructs the tray via the real (mocked) systray2 default export", async () => {
    process.env["AKSHARO_BRIDGE_TRAY"] = "native";
    delete process.env["CI"];
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => true }));
    vi.doMock("systray2", () => ({
      default: class {
        onReady() {
          return undefined;
        }
        onClick() {
          return Promise.resolve();
        }
        onError() {
          return undefined;
        }
        onExit() {
          return undefined;
        }
        sendAction() {
          return Promise.resolve();
        }
        kill() {
          return Promise.resolve();
        }
        ready() {
          return Promise.resolve();
        }
      },
    }));
    const { createNativeTray: freshCreateNativeTray } = await import("./native-tray.js");
    const tray = await freshCreateNativeTray({});
    expect(tray).toBeDefined();
    await tray?.close();
  });

  it("resolves undefined when importing systray2 itself throws", async () => {
    process.env["AKSHARO_BRIDGE_TRAY"] = "native";
    delete process.env["CI"];
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => true }));
    vi.doMock("systray2", () => {
      throw new Error("module load failed");
    });
    const { createNativeTray: freshCreateNativeTray } = await import("./native-tray.js");
    const tray = await freshCreateNativeTray({});
    expect(tray).toBeUndefined();
  });
});
