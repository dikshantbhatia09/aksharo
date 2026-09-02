import { describe, expect, it } from "vitest";

import { BridgeClient, MockBridgeTransport } from "./client.js";
import { BridgeRpcError } from "./protocol.js";

describe("BridgeClient", () => {
  it("calls hello and validates the result against the shared schema", async () => {
    const transport = new MockBridgeTransport();
    transport.on("hello", () => ({ bridgeVersion: 1, sessionId: "sess-1" }));
    const client = new BridgeClient(transport);

    const result = await client.call("hello", {
      bridgeVersion: 1,
      capabilities: [],
      hostApps: ["premiere"],
    });

    expect(result).toEqual({ bridgeVersion: 1, sessionId: "sess-1" });
    expect(transport.calls[0]?.method).toBe("hello");
  });

  it("rejects invalid params before sending (client-side schema validation)", async () => {
    const transport = new MockBridgeTransport();
    const client = new BridgeClient(transport);

    await expect(
      client.call("pair.request", {
        // @ts-expect-error -- deliberately invalid clientKind to exercise validation
        clientKind: "not-a-real-kind",
        clientName: "Aksharo Panel",
        scopes: [],
      }),
    ).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
  });

  it("surfaces a JSON-RPC error as a BridgeRpcError", async () => {
    const transport = new MockBridgeTransport();
    transport.on("session.exchange", () => {
      throw new BridgeRpcError(-32003, "pairing expired");
    });
    const client = new BridgeClient(transport);

    await expect(client.call("session.exchange", { pairToken: "tok" })).rejects.toMatchObject({
      code: -32003,
      message: "pairing expired",
    });
  });

  it("throws when no mock handler is registered for a method", async () => {
    const transport = new MockBridgeTransport();
    const client = new BridgeClient(transport);

    await expect(client.call("host.list", {})).rejects.toThrow(/no mock handler/);
  });

  it("supports media.uploadTicket end to end", async () => {
    const transport = new MockBridgeTransport();
    transport.on("media.uploadTicket", (params) => {
      expect(params).toEqual({ handle: "handle-1" });
      return { uploadUrl: "https://r2.example/put", expiresAt: "2026-09-03T00:00:00.000Z" };
    });
    const client = new BridgeClient(transport);

    const result = await client.call("media.uploadTicket", { handle: "handle-1" });
    expect(result.uploadUrl).toBe("https://r2.example/put");
  });
});
