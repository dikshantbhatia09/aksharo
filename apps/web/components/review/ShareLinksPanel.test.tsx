import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShareLinksPanel } from "./ShareLinksPanel";

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

describe("ShareLinksPanel", () => {
  it("lists existing links with their live state", async () => {
    renderWithProviders(<ShareLinksPanel projectId={PROJECT_ID} />, {
      routes: {
        [`/projects/${PROJECT_ID}/share-links`]: [LINK],
      },
    });

    await screen.findByTestId("share-link-item");
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("3 views")).toBeInTheDocument();
  });

  it("creates a link and posts the chosen scope", async () => {
    const { fetchMock } = renderWithProviders(<ShareLinksPanel projectId={PROJECT_ID} />, {
      routes: {
        [`/projects/${PROJECT_ID}/share-links`]: [],
      },
    });

    await screen.findByTestId("share-links-list");
    fireEvent.change(screen.getByTestId("share-create-scope"), { target: { value: "comment" } });
    fireEvent.click(screen.getByText("Create link"));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          new URL(String(input)).pathname === `/projects/${PROJECT_ID}/share-links` &&
          init?.method === "POST",
      );
      expect(createCall).toBeDefined();
      const body = JSON.parse(String(createCall?.[1]?.body)) as { scope: string };
      expect(body.scope).toBe("comment");
    });
  });

  it("revokes a live link", async () => {
    const { fetchMock } = renderWithProviders(<ShareLinksPanel projectId={PROJECT_ID} />, {
      routes: {
        [`/projects/${PROJECT_ID}/share-links`]: [LINK],
        [`/projects/${PROJECT_ID}/share-links/${LINK.id}`]: new Response(null, { status: 204 }),
      },
    });

    await screen.findByTestId("share-link-item");
    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() => {
      const revokeCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          new URL(String(input)).pathname === `/projects/${PROJECT_ID}/share-links/${LINK.id}` &&
          init?.method === "DELETE",
      );
      expect(revokeCall).toBeDefined();
    });
  });
});
