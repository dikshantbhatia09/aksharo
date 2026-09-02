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
