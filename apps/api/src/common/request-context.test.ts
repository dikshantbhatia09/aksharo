import { describe, expect, it } from "vitest";

import { newRequestId, normaliseRequestId, RequestContext } from "./request-context.js";

describe("newRequestId", () => {
  it("mints a 26-character ULID", () => {
    const id = newRequestId();
    expect(id).toHaveLength(26);
    expect(id).not.toBe(newRequestId());
  });
});

describe("normaliseRequestId", () => {
  it("keeps a well-formed inbound id so a trace survives the hop", () => {
    expect(normaliseRequestId("01JQ0000000000000000000001")).toBe("01JQ0000000000000000000001");
    expect(normaliseRequestId("req-abc_123.4")).toBe("req-abc_123.4");
  });

  it("replaces anything malformed rather than logging it", () => {
    for (const hostile of [
      "",
      "short",
      "a".repeat(65),
      "has space",
      "<script>",
      42,
      null,
      undefined,
    ]) {
      expect(normaliseRequestId(hostile)).toHaveLength(26);
    }
  });
});

describe("RequestContext", () => {
  it("is empty outside a request", () => {
    expect(RequestContext.get()).toBeUndefined();
    expect(RequestContext.requestId()).toBe("unknown");
  });

  it("carries the id through the async subtree", async () => {
    const seen = await RequestContext.run({ requestId: "r1" }, async () => {
      await Promise.resolve();
      return RequestContext.requestId();
    });
    expect(seen).toBe("r1");
    // …and does not leak back out.
    expect(RequestContext.requestId()).toBe("unknown");
  });

  it("accepts a principal once authentication has resolved it", () => {
    RequestContext.run({ requestId: "r2" }, () => {
      RequestContext.setPrincipal({ userId: "u1", workspaceId: "w1" });
      expect(RequestContext.get()).toEqual({ requestId: "r2", userId: "u1", workspaceId: "w1" });

      // A partial update leaves the other field alone.
      RequestContext.setPrincipal({ workspaceId: "w2" });
      expect(RequestContext.get()?.userId).toBe("u1");
      expect(RequestContext.get()?.workspaceId).toBe("w2");
    });
  });

  it("ignores a principal set outside a request instead of throwing", () => {
    expect(() => {
      RequestContext.setPrincipal({ userId: "u1" });
    }).not.toThrow();
  });

  it("keeps two concurrent requests apart", async () => {
    const one = RequestContext.run({ requestId: "a" }, async () => {
      await new Promise((done) => setTimeout(done, 5));
      return RequestContext.requestId();
    });
    const two = RequestContext.run({ requestId: "b" }, async () => RequestContext.requestId());

    expect(await Promise.all([one, two])).toEqual(["a", "b"]);
  });
});
