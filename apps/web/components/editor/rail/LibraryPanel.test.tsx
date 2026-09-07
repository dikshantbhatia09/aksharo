import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryPanel } from "./LibraryPanel";

import type { BrandAssetView } from "./brand-assets-endpoints";

import { renderWithProviders } from "@/test/harness";

const WORKSPACE_ID = "01JWORKSPACE";

const ASSET: BrandAssetView = {
  id: "01JASSET1",
  kind: "watermark",
  contentType: "image/png",
  sizeBytes: 10_240,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const PROJECT_PAGE = {
  items: [
    { id: "01JPROJ1", title: "Diwali promo", thumbnailUrl: "https://cdn.test/thumb.png" },
    { id: "01JPROJ2", title: "Untitled reel" },
  ],
  nextCursor: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<LibraryPanel />", () => {
  it("lists brand assets and recent projects — both real, reusable-asset concepts", async () => {
    renderWithProviders(<LibraryPanel />, {
      routes: {
        [`/workspaces/${WORKSPACE_ID}/brand-assets`]: [ASSET],
        "/projects": PROJECT_PAGE,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("library-brand-assets-list")).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("library-brand-asset-tile")).toHaveLength(1);

    expect(await screen.findByText("Diwali promo")).toBeInTheDocument();
    expect(screen.getByText("Untitled reel")).toBeInTheDocument();
    expect(screen.getAllByTestId("library-recent-project")).toHaveLength(2);
  });

  it("says so when there are no brand assets or recent projects yet", async () => {
    renderWithProviders(<LibraryPanel />, {
      routes: {
        [`/workspaces/${WORKSPACE_ID}/brand-assets`]: [],
        "/projects": { items: [], nextCursor: null },
      },
    });
    expect(await screen.findByText("No brand assets yet.")).toBeInTheDocument();
    expect(await screen.findByText("No other projects yet.")).toBeInTheDocument();
  });

  it("posts a create request for a valid PNG (the CustomFontsPanel test above proves the ticket->PUT leg of this same pattern end to end)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    // The harness mocks by pathname only, and `list` (GET) and `create`
    // (POST) share one path here, so both answer with this same empty-array
    // body — harmless: this test only asserts the create POST itself fired,
    // not what its (here, nonsensically-shaped) response contained.
    const { fetchMock } = renderWithProviders(<LibraryPanel />, {
      routes: {
        [`/workspaces/${WORKSPACE_ID}/brand-assets`]: [],
        "/projects": { items: [], nextCursor: null },
      },
    });
    await screen.findByText("No brand assets yet.");

    const file = new File([new Uint8Array(1024)], "logo.png", { type: "image/png" });
    await user.upload(screen.getByTestId("library-brand-asset-input"), file);

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes(`/workspaces/${WORKSPACE_ID}/brand-assets`) &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(createCall).toBeDefined();
    });
  });

  it("refuses a non-PNG file before calling the server", async () => {
    const { fetchMock } = renderWithProviders(<LibraryPanel />, {
      routes: {
        [`/workspaces/${WORKSPACE_ID}/brand-assets`]: [],
        "/projects": { items: [], nextCursor: null },
      },
    });
    await screen.findByText("No brand assets yet.");

    // `userEvent.upload` itself enforces the input's `accept` attribute and
    // silently refuses a mismatched file before `onChange` ever fires — this
    // test is for the component's OWN defensive check (an OS "all files"
    // picker or a drag-drop can still hand it a non-PNG), so it fires the
    // DOM event directly rather than going through that gate.
    const input = screen.getByTestId("library-brand-asset-input") as HTMLInputElement;
    const file = new File([new Uint8Array(10)], "logo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByTestId("library-error")).toHaveTextContent("PNG images only");
    // The list GET fires on mount regardless — what must NOT happen is a create POST.
    expect(
      fetchMock.mock.calls.some(
        ([requestInput, init]) =>
          String(requestInput).includes("/brand-assets") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });
});
