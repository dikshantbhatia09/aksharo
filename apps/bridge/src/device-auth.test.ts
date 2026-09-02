import { describe, expect, it, vi } from "vitest";

import {
  bootstrapDeviceCredentials,
  DeviceAuthError,
  refreshDeviceCredentials,
} from "./device-auth.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("bootstrapDeviceCredentials", () => {
  it("polls through authorization_pending, registers the device, and mints a bridge token", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/device/code")) {
        return jsonResponse(201, {
          deviceCode: "dc-1",
          userCode: "ABCD1234",
          verificationUrl: "https://app.test/device",
          verificationUrlComplete: "https://app.test/device?code=ABCD1234",
          interval: 1,
          expiresIn: 600,
        });
      }
      if (url.endsWith("/auth/device/token")) {
        const pollCount = calls.filter((c) => c.endsWith("/auth/device/token")).length;
        if (pollCount < 2) {
          return jsonResponse(400, { error: { code: "auth/authorization_pending" } });
        }
        return jsonResponse(200, {
          accessToken: "session-access",
          refreshToken: "session-refresh",
          expiresIn: 900,
        });
      }
      if (url.endsWith("/devices/register")) {
        expect((init?.headers as Record<string, string>)["authorization"]).toBe(
          "Bearer session-access",
        );
        return jsonResponse(201, { id: "dev-1" });
      }
      if (url.endsWith("/devices/dev-1/bridge-token")) {
        expect((init?.headers as Record<string, string>)["authorization"]).toBe(
          "Bearer session-access",
        );
        return jsonResponse(201, {
          accessToken: "bridge-token",
          expiresIn: 900,
          deviceId: "dev-1",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const pairingCodes: string[] = [];
    const result = await bootstrapDeviceCredentials({
      apiOrigin: "https://api.test",
      fingerprint: "fp-1",
      name: "Test Machine",
      platform: "win32",
      onPairingCode: (info) => pairingCodes.push(info.userCode),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    expect(pairingCodes).toEqual(["ABCD1234"]);
    expect(result.deviceId).toBe("dev-1");
    expect(result.sessionRefreshToken).toBe("session-refresh");
    expect(result.bridgeToken).toBe("bridge-token");
    expect(result.bridgeTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("throws when the device code request itself fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    await expect(
      bootstrapDeviceCredentials({
        apiOrigin: "https://api.test",
        fingerprint: "fp-1",
        name: "Test Machine",
        platform: "win32",
        onPairingCode: () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(DeviceAuthError);
  });

  it("throws when the code is denied", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/device/code")) {
        return jsonResponse(201, {
          deviceCode: "dc-1",
          userCode: "ABCD1234",
          verificationUrl: "https://app.test/device",
          verificationUrlComplete: "https://app.test/device?code=ABCD1234",
          interval: 1,
          expiresIn: 600,
        });
      }
      return jsonResponse(400, { error: { code: "auth/access_denied" } });
    });

    await expect(
      bootstrapDeviceCredentials({
        apiOrigin: "https://api.test",
        fingerprint: "fp-1",
        name: "Test Machine",
        platform: "win32",
        onPairingCode: () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/auth\/access_denied/);
  });
});

describe("refreshDeviceCredentials", () => {
  it("refreshes the session and re-mints the bridge token", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        return jsonResponse(200, {
          accessToken: "session-access-2",
          refreshToken: "session-refresh-2",
          expiresIn: 900,
        });
      }
      if (url.endsWith("/devices/dev-1/bridge-token")) {
        return jsonResponse(201, {
          accessToken: "bridge-token-2",
          expiresIn: 900,
          deviceId: "dev-1",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await refreshDeviceCredentials(
      "https://api.test",
      "dev-1",
      "session-refresh",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.bridgeToken).toBe("bridge-token-2");
    expect(result.sessionRefreshToken).toBe("session-refresh-2");
  });

  it("throws DeviceAuthError when the refresh token is dead", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: "auth/session_revoked" } }),
    );
    await expect(
      refreshDeviceCredentials(
        "https://api.test",
        "dev-1",
        "session-refresh",
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(DeviceAuthError);
  });
});
