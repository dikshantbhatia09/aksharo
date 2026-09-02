import { describe, expect, it } from "vitest";

import { MockWorkflowIntegrationHost } from "./workflow-integration.js";

describe("MockWorkflowIntegrationHost", () => {
  it("defaults to Studio with no discovery file yet", async () => {
    const host = new MockWorkflowIntegrationHost();
    await expect(host.isStudio()).resolves.toBe(true);
    await expect(host.readDiscoveryFile()).resolves.toBeUndefined();
    await expect(host.getHostVersion()).resolves.toBe("19.1.0");
  });

  it("reports the discovery file once set", async () => {
    const host = new MockWorkflowIntegrationHost();
    host.setDiscoveryFile({
      port: 47841,
      bearer: "secret",
      pid: 123,
      version: "0.1.0",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await expect(host.readDiscoveryFile()).resolves.toEqual({
      port: 47841,
      bearer: "secret",
      pid: 123,
      version: "0.1.0",
      startedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("can simulate a Free install", async () => {
    const host = new MockWorkflowIntegrationHost({ isStudio: false });
    await expect(host.isStudio()).resolves.toBe(false);
    host.setIsStudio(true);
    await expect(host.isStudio()).resolves.toBe(true);
  });

  it("records opened URLs", async () => {
    const host = new MockWorkflowIntegrationHost();
    await host.openExternalUrl("https://aksharo.ai/device");
    expect(host.openedUrls).toEqual(["https://aksharo.ai/device"]);
  });
});
