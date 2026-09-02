import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SupportView } from "./support-view";

import { renderWithProviders } from "@/test/harness";

const CONSENTS_TELEMETRY_OFF = {
  noticeVersion: "2026-09-01",
  reconsentRequired: false,
  purposes: [
    {
      purpose: "telemetry",
      granted: false,
      version: null,
      decidedAt: null,
      withdrawnAt: null,
      recorded: false,
    },
  ],
};

const CONSENTS_TELEMETRY_ON = {
  ...CONSENTS_TELEMETRY_OFF,
  purposes: [{ ...CONSENTS_TELEMETRY_OFF.purposes[0], granted: true, recorded: true }],
};

describe("SupportView — diagnostics bundle attach", () => {
  it("hides the bundle file input when telemetry consent is off", async () => {
    renderWithProviders(<SupportView />, {
      routes: { "/consents": CONSENTS_TELEMETRY_OFF, "/support/tickets": { tickets: [] } },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("support-bundle-input")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Turn on desktop\/plugin telemetry/)).toBeInTheDocument();
  });

  it("shows the bundle file input once telemetry consent is granted", async () => {
    renderWithProviders(<SupportView />, {
      routes: { "/consents": CONSENTS_TELEMETRY_ON, "/support/tickets": { tickets: [] } },
    });

    expect(await screen.findByTestId("support-bundle-input")).toBeInTheDocument();
  });
});
