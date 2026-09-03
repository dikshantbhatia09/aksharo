import { describe, expect, it } from "vitest";

import { runApply } from "./runApply.js";
import { MockRpcTransport, ResolveRpcClient } from "../rpc/client.js";

describe("runApply", () => {
  it("begins, steps every item, and commits", async () => {
    const transport = new MockRpcTransport();
    transport.on("apply.begin", () => ({ transactionId: "t1" }));
    transport.on("apply.step", () => ({ accepted: true }));
    transport.on("apply.commit", () => ({ appliedSteps: 2 }));
    const client = new ResolveRpcClient(transport);

    const result = await runApply(client, { projectId: "proj_1", itemIds: ["a", "b"] });

    expect(result).toEqual({ transactionId: "t1", appliedSteps: 2 });
    const stepCalls = transport.calls.filter((c) => c.method === "apply.step");
    expect(stepCalls).toHaveLength(2);
    expect(stepCalls[0]?.params).toEqual({
      transactionId: "t1",
      step: 0,
      payload: { itemId: "a" },
    });
  });

  it("aborts and rethrows when a step is rejected", async () => {
    const transport = new MockRpcTransport();
    transport.on("apply.begin", () => ({ transactionId: "t1" }));
    transport.on("apply.step", () => ({ accepted: false }));
    let abortReason: unknown;
    transport.on("apply.abort", (params) => {
      abortReason = params?.reason;
      return {};
    });
    const client = new ResolveRpcClient(transport);

    await expect(runApply(client, { projectId: "proj_1", itemIds: ["a"] })).rejects.toThrow(
      /rejected/,
    );
    expect(abortReason).toMatch(/rejected/);
  });
});
