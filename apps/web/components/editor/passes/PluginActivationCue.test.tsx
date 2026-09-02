import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DeviceView, Entitlement } from "@montaj/api-client";

import { PluginActivationCue } from "./PluginActivationCue";

import { renderWithProviders } from "@/test/harness";

function entitlement(activeDevices: number): Entitlement {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 0,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: { activeDevices },
    computedAt: "2026-09-03T00:00:00.000Z",
  };
}

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

/**
 * Passes tab licensing cue (08 §4 "Passes tab licensing cues", brief §3):
 * reads the same `devices` + `entitlement` data the Plugins page does, no
 * plugin code of its own.
 */
describe("<PluginActivationCue />", () => {
  it("shows installed + signed in when a device for this host is active", async () => {
    renderWithProviders(<PluginActivationCue host="premiere" />, {
      routes: {
        "/devices": [device({ host: "premiere" })],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(1),
      },
    });
    const cue = await screen.findByTestId("passes-plugin-cue-premiere");
    expect(cue).toHaveTextContent("Installed and signed in");
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
  });

  it("shows not installed and a Set up link when nothing is signed in", async () => {
    renderWithProviders(<PluginActivationCue host="resolve" />, {
      routes: {
        "/devices": [],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(1),
      },
    });
    const cue = await screen.findByTestId("passes-plugin-cue-resolve");
    expect(cue).toHaveTextContent("Not installed");
    expect(screen.getByText("Set up")).toBeInTheDocument();
  });

  it("shows device limit reached when at the plan's device limit with no device of this kind", async () => {
    renderWithProviders(<PluginActivationCue host="resolve" />, {
      routes: {
        "/devices": [device({ host: "premiere" })],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(1),
      },
    });
    const cue = await screen.findByTestId("passes-plugin-cue-resolve");
    expect(cue).toHaveTextContent("Device limit reached");
  });
});
