import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WhatsNewModal } from "./whats-new-modal";

import { renderWithProviders } from "@/test/harness";

const LATEST = { version: "2026.09.1", title: "Reframe presets", tags: ["editor"] };

/**
 * The modal reads the changelog from this app's own route handler with a
 * relative URL, which is global `fetch`, not the harness's API double.
 */
function stubChangelogRoute(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(LATEST), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<WhatsNewModal />", () => {
  it("opens for a user who has projects and has not dismissed this version", async () => {
    stubChangelogRoute();
    renderWithProviders(<WhatsNewModal hasProjects />, {
      routes: { "/academy/changelog/dismissed": { dismissedVersion: null } },
    });
    expect(await screen.findByTestId("whats-new-modal")).toHaveTextContent("Reframe presets");
  });

  // F07-D3: on a brand-new account this modal landed on top of Home's
  // quick-pick — the one control that account needs.
  it("never covers a first run, and does not burn the version doing so", async () => {
    stubChangelogRoute();
    const { fetchMock } = renderWithProviders(<WhatsNewModal hasProjects={false} />, {
      routes: { "/academy/changelog/dismissed": { dismissedVersion: null } },
    });

    // Give the changelog fetch and the dismissed query time to settle; the
    // modal must still be absent afterwards.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/academy/changelog")),
      ).toBe(true);
    });
    expect(screen.queryByTestId("whats-new-modal")).toBeNull();

    // Nothing was marked seen, so the first launch after their first project
    // still gets the news.
    const dismissPost = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(dismissPost).toBeUndefined();
  });
});
