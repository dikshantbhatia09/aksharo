import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IntegrationsView } from "./integrations-view";

import { renderWithProviders } from "@/test/harness";

describe("<IntegrationsView />", () => {
  it("renders Zoom, Riverside, Google Meet sections and empty ledger", async () => {
    renderWithProviders(<IntegrationsView />, {
      routes: {
        "/integrations/zoom": { connected: false },
        "/integrations/zoom/events": [],
      },
    });

    expect(await screen.findByTestId("settings-integrations")).toBeInTheDocument();
    expect(screen.getByText("Zoom Cloud")).toBeInTheDocument();
    expect(screen.getByText("Riverside.fm Studio")).toBeInTheDocument();
    expect(screen.getByText("Google Meet")).toBeInTheDocument();
    expect(screen.getByText("Recording Ingestion Ledger")).toBeInTheDocument();
    expect(await screen.findByTestId("zoom-connect-btn")).toBeInTheDocument();
    expect(screen.getByTestId("riverside-import-btn")).toBeInTheDocument();
    expect(screen.getByTestId("meet-import-btn")).toBeInTheDocument();
  });

  it("renders connected Zoom integration state with preferences and manual import", async () => {
    renderWithProviders(<IntegrationsView />, {
      routes: {
        "/integrations/zoom": {
          id: "int-123",
          workspaceId: "01JWORKSPACE",
          zoomUserId: "usr-456",
          zoomEmail: "host@example.com",
          autoRepurpose: true,
          minDurationSec: 900,
          nameFilter: "#webinar",
          createdAt: new Date().toISOString(),
        },
        "/integrations/zoom/events": [
          {
            id: "evt-1",
            meetingId: "987654321",
            topic: "Product Demo",
            durationMin: 45,
            fileCount: 3,
            status: "COMPLETED",
            projectId: "proj-1",
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });

    expect(await screen.findByText("Connected as host@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-manual-import-btn")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-save-settings-btn")).toBeInTheDocument();
    expect(screen.getByText("987654321")).toBeInTheDocument();
    expect(screen.getByText("Product Demo")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
  });
});

