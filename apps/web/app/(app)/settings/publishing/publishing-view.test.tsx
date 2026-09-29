import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PublishingView } from "./publishing-view";

import { renderWithProviders } from "@/test/harness";

const STATUS = {
  enabled: true,
  available: false,
  reason: "not_configured",
  message:
    "Posting is not set up yet: connect your accounts in Postiz and give Aksharo its API key.",
  postizUrl: "http://localhost:4007",
  channelCount: 0,
};

describe("Settings → Publishing", () => {
  it("explains how to connect accounts through Postiz, with the link and the key's name", async () => {
    renderWithProviders(<PublishingView />, {
      routes: {
        "/publishing/status": STATUS,
        "/publishing/channels": { status: STATUS, channels: [] },
      },
    });
    expect(await screen.findByTestId("publishing-missing")).toHaveTextContent(
      "Posting is not set up yet",
    );
    const setup = screen.getByTestId("publishing-setup");
    expect(within(setup).getByTestId("publishing-postiz-link")).toHaveAttribute(
      "href",
      "http://localhost:4007",
    );
    expect(setup).toHaveTextContent("POSTIZ_API_KEY");
    expect(setup).toHaveTextContent("POSTIZ_WORKSPACE_IDS");
    expect(setup).toHaveTextContent("01JWORKSPACE");
  });

  it("lists the connected accounts once it is set up", async () => {
    const ready = { ...STATUS, available: true, reason: null, message: null, channelCount: 1 };
    renderWithProviders(<PublishingView />, {
      routes: {
        "/publishing/status": ready,
        "/publishing/channels": {
          status: ready,
          channels: [
            {
              id: "01JS0000000000000000CHANIG",
              provider: "instagram",
              platform: "Instagram",
              name: "Crest Mond",
              username: "crestmond",
              avatarUrl: null,
              supported: true,
              disabled: false,
              note: null,
            },
          ],
        },
      },
    });
    expect(await screen.findByTestId("publishing-status")).toHaveTextContent("Ready. 1 account");
    expect(await screen.findByTestId("publishing-account-Instagram")).toHaveTextContent(
      "Crest Mond @crestmond",
    );
  });

  it("only says it is off for a workspace without it", async () => {
    renderWithProviders(<PublishingView />, {
      routes: { "/publishing/status": { ...STATUS, enabled: false, reason: "flag_off" } },
    });
    expect(await screen.findByTestId("publishing-off")).toHaveTextContent(
      "not switched on for this workspace",
    );
    expect(screen.queryByTestId("publishing-setup")).not.toBeInTheDocument();
  });
});
