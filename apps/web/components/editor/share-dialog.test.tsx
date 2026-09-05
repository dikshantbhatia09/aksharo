import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ShareDialog } from "./ShareDialog";

import { renderWithProviders } from "@/test/harness";

const PROJECT_ID = "01JPROJECT0000000000000AA";

const LINK = {
  id: "01JLINK00000000000000000A",
  projectId: PROJECT_ID,
  token: "abc123def456ghi789jklmno",
  scope: "view",
  hasPassword: false,
  expiresAt: null,
  maxViews: null,
  viewCount: 3,
  clientTag: null,
  reportCount: 0,
  revokedAt: null,
  autoDisabled: false,
  createdAt: "2026-09-02T00:00:00.000Z",
  url: "https://app.example.test/share/abc123def456ghi789jklmno",
};

const routes = { [`/projects/${PROJECT_ID}/share-links`]: [LINK] };

describe("<ShareDialog />", () => {
  it("renders the share-links panel when open", async () => {
    renderWithProviders(
      <ShareDialog projectId={PROJECT_ID} open onOpenChange={() => undefined} />,
      { routes },
    );

    expect(await screen.findByTestId("share-dialog")).toBeInTheDocument();
    expect(await screen.findByTestId("share-links-panel")).toBeInTheDocument();
    // Not just the frame: the panel's own data reached the screen.
    expect(await screen.findByTestId("share-link-item")).toBeInTheDocument();
  });

  it("renders nothing — and asks the server for nothing — while closed", async () => {
    const { fetchMock } = renderWithProviders(
      <ShareDialog projectId={PROJECT_ID} open={false} onOpenChange={() => undefined} />,
      { routes },
    );

    expect(screen.queryByTestId("share-dialog")).toBeNull();
    expect(screen.queryByTestId("share-links-panel")).toBeNull();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/share-links"))).toBe(
        false,
      );
    });
  });

  it("reports a close back to the caller that owns the open state", async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(<ShareDialog projectId={PROJECT_ID} open onOpenChange={onOpenChange} />, {
      routes,
    });

    (await screen.findByRole("button", { name: "Close" })).click();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
