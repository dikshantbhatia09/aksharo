import { describe, expect, it, vi } from "vitest";

import { createTelemetryClient } from "./client.js";

function fakeFetch(status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status });
}

describe("createTelemetryClient", () => {
  it("posts an event batch with the device token and app version", async () => {
    const fetchImpl = fakeFetch();
    const client = createTelemetryClient({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      appVersion: "1.0.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.reportEvent("bridge_connected", { port: 51820 });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.aksharo.test/telemetry/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer dev-token" }),
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      events: { kind: string; props: unknown }[];
    };
    expect(body.events[0]?.kind).toBe("bridge_connected");
  });

  it("returns ok:false (never throws) when the API rejects the request", async () => {
    const fetchImpl = fakeFetch(500);
    const client = createTelemetryClient({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      appVersion: "1.0.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.reportEvent("bridge_connected")).resolves.toEqual({ ok: false });
  });

  it("returns ok:false when fetch itself throws (offline)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const client = createTelemetryClient({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      appVersion: "1.0.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.reportEvent("bridge_connected")).resolves.toEqual({ ok: false });
  });

  it("redacts the stack and log tail of a crash report", async () => {
    const fetchImpl = fakeFetch();
    const client = createTelemetryClient({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      appVersion: "1.0.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.reportCrash(
      { message: "boom", stack: "Error: boom at C:\\Users\\dikshant\\app.js" },
      "Windows 11",
      ["user email leak@example.com"],
    );

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      stack: string;
      logTail: string[];
    };
    expect(body.stack).not.toContain("dikshant");
    expect(body.logTail[0]).not.toContain("@example.com");
  });
});
