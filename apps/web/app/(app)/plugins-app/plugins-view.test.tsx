import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  DeviceView,
  Entitlement,
  LicenseKeyView,
  PluginManifestResponse,
} from "@montaj/api-client";

import { PluginsView } from "./plugins-view";

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
    lastActiveAt: "2026-09-02T00:00:00.000Z",
    leaseUntil: "2026-09-09T00:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    isCurrentSession: false,
    ...overrides,
  };
}

const UNAVAILABLE_MANIFEST: PluginManifestResponse = {
  channels: {
    "premiere-uxp": {
      available: false,
      version: null,
      minHostVersion: null,
      maxHostVersion: null,
      downloadUrl: null,
    },
    "ae-cep": {
      available: false,
      version: null,
      minHostVersion: null,
      maxHostVersion: null,
      downloadUrl: null,
    },
    "resolve-script": {
      available: false,
      version: null,
      minHostVersion: null,
      maxHostVersion: null,
      downloadUrl: null,
    },
  },
};

const NO_KEYS: LicenseKeyView[] = [];

/**
 * Plugins page (08 §4 "the activation card (v2)", D65 naming): both
 * activation cards, merged licence-key management, and the
 * activation-limit-reached upgrade path.
 */
describe("<PluginsView />", () => {
  it("names both products per D65 and shows each device under its own card", async () => {
    renderWithProviders(<PluginsView />, {
      routes: {
        "/devices": [
          device({ host: "premiere" }),
          device({ id: "d2", host: "resolve", name: "Edit Bay" }),
        ],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(5),
        "/plugins/manifest": UNAVAILABLE_MANIFEST,
        "/workspaces/01JWORKSPACE/license-keys": NO_KEYS,
      },
    });

    await screen.findByText(
      "Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects",
    );
    const page = await screen.findByTestId("plugins-page");
    expect(page).toHaveTextContent("Aksharo — works with DaVinci Resolve");

    expect(await screen.findByTestId("activation-card-adobe-state")).toHaveTextContent(
      "Installed and signed in",
    );
    expect(screen.getByTestId("activation-card-resolve-state")).toHaveTextContent(
      "Installed and signed in",
    );
    expect(screen.getByTestId("activation-card-adobe-devices")).toHaveTextContent("Studio PC");
    expect(screen.getByTestId("activation-card-resolve-devices")).toHaveTextContent("Edit Bay");

    // Licence keys merged onto the same page (brief §2).
    expect(await screen.findByTestId("license-keys-page")).toBeInTheDocument();
    expect(page).toHaveTextContent("not affiliated with or endorsed by Adobe or Blackmagic Design");
  });

  it("shows device limit reached and an upgrade gate once the plan's device limit is hit", async () => {
    renderWithProviders(<PluginsView />, {
      routes: {
        "/devices": [device({ host: "premiere" })],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(1),
        "/plugins/manifest": UNAVAILABLE_MANIFEST,
        "/workspaces/01JWORKSPACE/license-keys": NO_KEYS,
        "/billing/plans": [
          {
            key: "starter",
            name: "Starter",
            prices: { INR: { month: 29_900, year: 298_800 }, USD: { month: 900, year: 8_600 } },
            creditsPerMonthTenths: 1_000,
            seatPrice: null,
            hasHalfyear: { INR: false, USD: false },
          },
        ],
      },
    });

    expect(await screen.findByTestId("activation-card-resolve-state")).toHaveTextContent(
      "Device limit reached",
    );
    expect(await screen.findAllByTestId("upgrade-gate")).toHaveLength(1);
  });
});
