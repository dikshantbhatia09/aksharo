import { describe, expect, it } from "vitest";

import type { DeviceView } from "@montaj/api-client";

import {
  ADOBE_HOSTS,
  RESOLVE_HOSTS,
  activationStateFor,
  activeDevicesForHosts,
  channelUnavailable,
  isDeviceLimitReached,
} from "./plugin-status";

function device(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: "d1",
    name: "Studio PC",
    platform: "windows",
    host: "premiere",
    hostVersion: null,
    appVersion: null,
    lastActiveAt: null,
    leaseUntil: null,
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    isCurrentSession: false,
    ...overrides,
  };
}

describe("activationStateFor", () => {
  it("is signed_in when an active device exists for one of the hosts", () => {
    const state = activationStateFor([device({ host: "premiere" })], ADOBE_HOSTS, false);
    expect(state).toBe("signed_in");
  });

  it("ignores a revoked device", () => {
    const state = activationStateFor(
      [device({ host: "premiere", revokedAt: "2026-09-02T00:00:00.000Z" })],
      ADOBE_HOSTS,
      false,
    );
    expect(state).toBe("not_installed");
  });

  it("ignores a device for a different host group", () => {
    const state = activationStateFor([device({ host: "resolve" })], ADOBE_HOSTS, false);
    expect(state).toBe("not_installed");
  });

  it("is limit_reached when at the device limit with no active device of this kind", () => {
    const state = activationStateFor([device({ host: "resolve" })], ADOBE_HOSTS, true);
    expect(state).toBe("limit_reached");
  });

  it("signed_in wins over limit_reached -- an already-connected plugin keeps working", () => {
    const state = activationStateFor([device({ host: "premiere" })], ADOBE_HOSTS, true);
    expect(state).toBe("signed_in");
  });

  it("resolve hosts are distinct from adobe hosts", () => {
    expect(RESOLVE_HOSTS).toEqual(["resolve"]);
    expect(ADOBE_HOSTS).toEqual(["premiere", "ae"]);
  });
});

describe("activeDevicesForHosts", () => {
  it("filters by host and excludes revoked devices", () => {
    const devices = [
      device({ id: "a", host: "premiere" }),
      device({ id: "b", host: "ae", revokedAt: "2026-09-02T00:00:00.000Z" }),
      device({ id: "c", host: "resolve" }),
    ];
    expect(activeDevicesForHosts(devices, ADOBE_HOSTS).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("isDeviceLimitReached", () => {
  it("is true at or above the limit", () => {
    expect(isDeviceLimitReached(1, 1)).toBe(true);
    expect(isDeviceLimitReached(2, 1)).toBe(true);
    expect(isDeviceLimitReached(0, 1)).toBe(false);
  });
});

describe("channelUnavailable", () => {
  it("is true for an undefined channel or one marked unavailable", () => {
    expect(channelUnavailable(undefined)).toBe(true);
    expect(
      channelUnavailable({
        available: false,
        version: null,
        minHostVersion: null,
        maxHostVersion: null,
        downloadUrl: null,
        channel: null,
        notes: null,
      }),
    ).toBe(true);
    expect(
      channelUnavailable({
        available: true,
        version: "1.0.0",
        minHostVersion: "25.6",
        maxHostVersion: null,
        downloadUrl: "https://example.test/panel.ccx",
        channel: "stable",
        notes: null,
      }),
    ).toBe(false);
  });
});
