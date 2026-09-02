import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PrivacyView } from "./privacy-view";

import { renderWithProviders } from "@/test/harness";

const ME = {
  id: "01JUSER0000000000000000000",
  email: "person@example.test",
  ageBracket: "adult",
};

const CONSENTS_OFF = {
  noticeVersion: "2026-09-01",
  reconsentRequired: false,
  purposes: [
    {
      purpose: "analytics",
      granted: false,
      version: null,
      decidedAt: null,
      withdrawnAt: null,
      recorded: false,
    },
    {
      purpose: "memory",
      granted: false,
      version: null,
      decidedAt: null,
      withdrawnAt: null,
      recorded: false,
    },
    {
      purpose: "marketing",
      granted: false,
      version: null,
      decidedAt: null,
      withdrawnAt: null,
      recorded: false,
    },
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

describe("PrivacyView — telemetry consent", () => {
  it("renders the telemetry toggle, off by default", async () => {
    renderWithProviders(<PrivacyView />, { routes: { "/me": ME, "/consents": CONSENTS_OFF } });

    const toggle = await screen.findByTestId("settings-telemetry");
    expect(toggle).toBeInTheDocument();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects a granted telemetry consent from the server", async () => {
    const granted = {
      ...CONSENTS_OFF,
      purposes: CONSENTS_OFF.purposes.map((p) =>
        p.purpose === "telemetry" ? { ...p, granted: true, recorded: true } : p,
      ),
    };
    renderWithProviders(<PrivacyView />, { routes: { "/me": ME, "/consents": granted } });

    await waitFor(() => {
      expect(screen.getByTestId("settings-telemetry").getAttribute("aria-checked")).toBe("true");
    });
  });

  it("posts a telemetry grant to /consents when the toggle is switched on", async () => {
    const { fetchMock } = renderWithProviders(<PrivacyView />, {
      routes: {
        "/me": ME,
        "/consents": CONSENTS_OFF,
      },
    });

    const toggle = await screen.findByTestId("settings-telemetry");
    toggle.click();

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => {
        const url = String(input);
        return url.includes("/consents") && (init as RequestInit | undefined)?.method === "POST";
      });
      expect(call).toBeDefined();
      const body = JSON.parse((call?.[1] as RequestInit).body as string) as {
        purpose: string;
        granted: boolean;
      };
      expect(body).toEqual({ purpose: "telemetry", granted: true });
    });
  });
});
