import { describe, expect, it } from "vitest";

import { acceptedItemIds, fetchPasses } from "./passes.js";
import { MockRpcTransport, ResolveRpcClient } from "../rpc/client.js";

describe("fetchPasses", () => {
  it("calls passes.list and returns the result verbatim", async () => {
    const transport = new MockRpcTransport();
    transport.on("passes.list", () => ({
      passes: [
        {
          passId: "pass_1",
          type: "autocut",
          items: [{ itemId: "item_1", kind: "cut", state: "accepted" }],
        },
      ],
    }));
    const client = new ResolveRpcClient(transport);

    const result = await fetchPasses(client);

    expect(result.passes).toHaveLength(1);
  });
});

describe("acceptedItemIds", () => {
  it("flattens only accepted items across passes", () => {
    const result = {
      passes: [
        {
          passId: "pass_1",
          type: "autocut",
          items: [
            { itemId: "a", kind: "cut", state: "accepted" },
            { itemId: "b", kind: "cut", state: "proposed" },
          ],
        },
        {
          passId: "pass_2",
          type: "zoom",
          items: [{ itemId: "c", kind: "zoom", state: "accepted" }],
        },
      ],
    };
    expect(acceptedItemIds(result)).toEqual(["a", "c"]);
  });
});
