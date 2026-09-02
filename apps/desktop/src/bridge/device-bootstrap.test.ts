import { describe, expect, it, vi } from "vitest";

import { InMemoryKeyStore } from "@montaj/bridge-core";

import { bootstrapDevice } from "./device-bootstrap.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("bootstrapDevice", () => {
  it("returns undefined when there is no access token yet", async () => {
    const keyStore = new InMemoryKeyStore();
    const fetchImpl = vi.fn();
    const result = await bootstrapDevice({
      apiOrigin: "https://api.test",
      deviceName: "Test Mac",
      platform: "darwin",
      getAccessToken: () => undefined,
      keyStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("registers the device and mints a bridge token, caching both", async () => {
    const keyStore = new InMemoryKeyStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "device-1" }))
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "bridge-token-secret", expiresIn: 3600, deviceId: "device-1" }),
      );

    const result = await bootstrapDevice({
      apiOrigin: "https://api.test",
      deviceName: "Test Mac",
      platform: "darwin",
      appVersion: "1.0.0",
      getAccessToken: () => "user-access-token",
      keyStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ deviceId: "device-1", deviceToken: "bridge-token-secret" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [registerUrl, registerInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(registerUrl).toBe("https://api.test/devices/register");
    expect(registerInit.method).toBe("POST");
    expect((registerInit.headers as Record<string, string>).authorization).toBe(
      "Bearer user-access-token",
    );
    const registerBody = JSON.parse(registerInit.body as string) as Record<string, unknown>;
    expect(registerBody.host).toBe("desktop");
    expect(typeof registerBody.fingerprint).toBe("string");
    expect((registerBody.fingerprint as string).length).toBeGreaterThanOrEqual(8);

    const [tokenUrl] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(tokenUrl).toBe("https://api.test/devices/device-1/bridge-token");

    expect(await keyStore.load("device-bridge-token")).toBe("bridge-token-secret");
    expect(await keyStore.load("device-id")).toBe("device-1");
  });

  it("reuses a cached credential without calling fetch when the lease is fresh", async () => {
    const keyStore = new InMemoryKeyStore();
    await keyStore.save("device-id", "device-1");
    await keyStore.save("device-bridge-token", "cached-token");
    await keyStore.save(
      "device-bridge-token-expires-at",
      new Date(Date.now() + 3600_000).toISOString(),
    );
    const fetchImpl = vi.fn();

    const result = await bootstrapDevice({
      apiOrigin: "https://api.test",
      deviceName: "Test Mac",
      platform: "darwin",
      getAccessToken: () => "user-access-token",
      keyStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ deviceId: "device-1", deviceToken: "cached-token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-registers once the cached lease is within the refresh skew of expiring", async () => {
    const keyStore = new InMemoryKeyStore();
    await keyStore.save("device-id", "device-1");
    await keyStore.save("device-bridge-token", "stale-token");
    await keyStore.save(
      "device-bridge-token-expires-at",
      new Date(Date.now() + 1000).toISOString(),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "device-1" }))
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "fresh-token", expiresIn: 3600, deviceId: "device-1" }),
      );

    const result = await bootstrapDevice({
      apiOrigin: "https://api.test",
      deviceName: "Test Mac",
      platform: "darwin",
      getAccessToken: () => "user-access-token",
      keyStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ deviceId: "device-1", deviceToken: "fresh-token" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws when device registration fails", async () => {
    const keyStore = new InMemoryKeyStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "nope" }, 409));

    await expect(
      bootstrapDevice({
        apiOrigin: "https://api.test",
        deviceName: "Test Mac",
        platform: "darwin",
        getAccessToken: () => "user-access-token",
        keyStore,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/device registration failed/);
  });
});
