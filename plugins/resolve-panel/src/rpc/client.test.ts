import { describe, expect, it } from "vitest";

import { MockRpcTransport, ResolveRpcClient } from "./client.js";
import { ResolveRpcError } from "./protocol.js";

describe("ResolveRpcClient", () => {
  it("calls the transport with an incrementing request id", async () => {
    const transport = new MockRpcTransport();
    transport.on("host.info", () => ({ hostApp: "resolve", connected: true }));
    const client = new ResolveRpcClient(transport);

    const result = await client.call("host.info");

    expect(result).toEqual({ hostApp: "resolve", connected: true });
    expect(transport.calls[0]?.id).toBe(1);
    expect(transport.calls[0]?.method).toBe("host.info");
  });

  it("passes params through", async () => {
    const transport = new MockRpcTransport();
    transport.on("apply.step", (params) => ({ accepted: params?.step === 0 }));
    const client = new ResolveRpcClient(transport);

    const result = await client.call<{ accepted: boolean }>("apply.step", {
      transactionId: "t1",
      step: 0,
      payload: {},
    });

    expect(result.accepted).toBe(true);
  });

  it("throws ResolveRpcError on an error response", async () => {
    const transport = new MockRpcTransport();
    transport.on("timeline.current", () => {
      throw new Error("boom");
    });
    const client = new ResolveRpcClient(transport);

    await expect(client.call("timeline.current")).rejects.toBeInstanceOf(ResolveRpcError);
  });

  it("reports method-not-found for an unregistered handler", async () => {
    const transport = new MockRpcTransport();
    const client = new ResolveRpcClient(transport);

    await expect(client.call("nope")).rejects.toMatchObject({ code: -32601 });
  });
});
