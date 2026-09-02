import { describe, expect, it, vi } from "vitest";

import { createStubBridgeAdapter } from "./adapter.js";

describe("createStubBridgeAdapter", () => {
  it("starts in a stopped state", () => {
    const adapter = createStubBridgeAdapter();
    expect(adapter.getStatus()).toEqual({ status: "stopped", pairedClients: [] });
  });

  it("reports an error status on start (bridge-core not merged yet)", async () => {
    const adapter = createStubBridgeAdapter();
    const listener = vi.fn();
    adapter.onStatusChange(listener);
    await adapter.start();
    expect(adapter.getStatus().status).toBe("error");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("rejects approvePairing", async () => {
    const adapter = createStubBridgeAdapter();
    await expect(adapter.approvePairing("ABCDEFGH")).rejects.toThrow(/not yet available/);
  });

  it("returns to stopped on stop() and unsubscribes listeners", async () => {
    const adapter = createStubBridgeAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.onStatusChange(listener);
    await adapter.start();
    await adapter.stop();
    expect(adapter.getStatus().status).toBe("stopped");
    unsubscribe();
    listener.mockClear();
    await adapter.start();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createBridgeAdapter", () => {
  it("starts, reports a running status with a port, and stops", async () => {
    const { createBridgeAdapter } = await import("./adapter.js");
    const adapter = createBridgeAdapter();
    const events: string[] = [];
    adapter.onStatusChange((e) => events.push(e.status));

    await adapter.start();
    expect(adapter.getStatus().status).toBe("running");
    expect(adapter.getStatus().port).toBeGreaterThan(0);
    expect(events).toContain("starting");
    expect(events).toContain("running");

    await adapter.stop();
    expect(adapter.getStatus().status).toBe("stopped");
  });

  it("rejects approvePairing when there is no pending request", async () => {
    const { createBridgeAdapter } = await import("./adapter.js");
    const adapter = createBridgeAdapter();
    await adapter.start();
    await expect(adapter.approvePairing("ABCDEFGH")).rejects.toThrow(/no pending/i);
    await adapter.stop();
  });

  // A full "remote client pairs, tray approves, remote client confirms" flow
  // is exercised end-to-end in `packages/bridge-core`'s own `server.test.ts`
  // and `pairing.test.ts`; `BridgeAdapter` does not expose the bearer token
  // or a raw RPC surface needed to drive that same flow from the outside, so
  // it is not duplicated here (see the module doc comment's "known interface
  // gap" note).
});
