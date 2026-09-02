import { describe, expect, it } from "vitest";

import { MockRpcTransport } from "./client.js";
import { tryConnect } from "./connect.js";
import { MockWorkflowIntegrationHost } from "../host/workflow-integration.js";

describe("tryConnect", () => {
  it("returns undefined when the script hasn't started (no discovery file)", async () => {
    const host = new MockWorkflowIntegrationHost();
    const result = await tryConnect({
      host,
      createTransport: () => new MockRpcTransport(),
    });
    expect(result).toBeUndefined();
  });

  it("builds a client against the discovered port/bearer once the script is up", async () => {
    const host = new MockWorkflowIntegrationHost();
    host.setDiscoveryFile({
      port: 47842,
      bearer: "secret-token",
      pid: 1,
      version: "0.1.0",
      startedAt: "2026-01-01T00:00:00Z",
    });
    const seenArgs: { port: number; bearer: string }[] = [];
    const result = await tryConnect({
      host,
      createTransport: (port, bearer) => {
        seenArgs.push({ port, bearer });
        return new MockRpcTransport();
      },
    });

    expect(result?.port).toBe(47842);
    expect(seenArgs).toEqual([{ port: 47842, bearer: "secret-token" }]);
  });
});
