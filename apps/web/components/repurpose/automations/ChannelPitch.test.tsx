import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ChannelPitch } from "./ChannelPitch";

import { renderWithProviders } from "@/test/harness";

function entitlement(on: boolean): unknown {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 2_000,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: { flags: { repurpose_automations: on } },
    computedAt: "2027-01-01T00:00:00.000Z",
  };
}

function routes(on: boolean, watches: number): Record<string, unknown> {
  return {
    "/workspaces/01JWORKSPACE/entitlement": entitlement(on),
    "/repurpose/watches": {
      items: Array.from({ length: watches }, (_, index) => ({ id: `W${String(index)}` })),
      checksEnabled: true,
      maxWatches: 10,
    },
  };
}

describe("<ChannelPitch />", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("offers to follow a channel once a link run's clips arrive", async () => {
    renderWithProviders(<ChannelPitch sourceKind="youtube_url" hasReadyClips />, {
      routes: routes(true, 0),
    });
    expect(await screen.findByTestId("channel-pitch")).toBeInTheDocument();
    expect(screen.getByTestId("channel-pitch-open")).toHaveAttribute(
      "href",
      "/repurpose/automations",
    );
  });

  it("says nothing to a workspace that already follows one, an upload, or with automations off", async () => {
    const following = renderWithProviders(<ChannelPitch sourceKind="youtube_url" hasReadyClips />, {
      routes: routes(true, 1),
    });
    await waitFor(() => {
      expect(
        following.fetchMock.mock.calls.some(([url]) => String(url).includes("/repurpose/watches")),
      ).toBe(true);
    });
    expect(screen.queryByTestId("channel-pitch")).not.toBeInTheDocument();
    following.unmount();

    const upload = renderWithProviders(<ChannelPitch sourceKind="upload" hasReadyClips />, {
      routes: routes(true, 0),
    });
    await waitFor(() => {
      expect(upload.fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("channel-pitch")).not.toBeInTheDocument();
    upload.unmount();

    const off = renderWithProviders(<ChannelPitch sourceKind="youtube_url" hasReadyClips />, {
      routes: routes(false, 0),
    });
    await waitFor(() => {
      expect(off.fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("channel-pitch")).not.toBeInTheDocument();
    expect(
      off.fetchMock.mock.calls.some(([url]) => String(url).includes("/repurpose/watches")),
    ).toBe(false);
  });

  it("stays away once put away", async () => {
    const first = renderWithProviders(<ChannelPitch sourceKind="youtube_url" hasReadyClips />, {
      routes: routes(true, 0),
    });
    await userEvent.click(await screen.findByTestId("channel-pitch-dismiss"));
    expect(screen.queryByTestId("channel-pitch")).not.toBeInTheDocument();
    first.unmount();

    const again = renderWithProviders(<ChannelPitch sourceKind="youtube_url" hasReadyClips />, {
      routes: routes(true, 0),
    });
    await waitFor(() => {
      expect(
        again.fetchMock.mock.calls.some(([url]) => String(url).includes("/repurpose/watches")),
      ).toBe(true);
    });
    expect(screen.queryByTestId("channel-pitch")).not.toBeInTheDocument();
  });
});
