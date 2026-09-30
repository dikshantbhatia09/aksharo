import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrollLibraryView } from "./broll-library-view";

import type {
  BrollLibraryView as LibraryResponse,
  BrollPicture,
} from "@/components/broll/use-broll-library";

import { renderWithProviders, testAccessToken } from "@/test/harness";

const LIMITS: LibraryResponse["limits"] = {
  maxBytes: 8 * 1024 * 1024,
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  minSide: 320,
  maxSide: 3840,
  uploadLongSide: 2560,
  maxAssets: 300,
  maxTags: 10,
  tagMax: 40,
  titleMax: 120,
};

const TAJ: BrollPicture = {
  assetId: "01JPX0000000000000000000T1",
  format: "jpeg",
  contentType: "image/jpeg",
  width: 1440,
  height: 2560,
  sizeBytes: 400_000,
  tags: ["taj mahal", "agra"],
  title: "Taj at dawn",
  source: "upload",
  credit: null,
  url: "https://cdn.test/broll/taj.jpg",
  createdAt: "2026-10-05T09:00:00.000Z",
};

const CHAI: BrollPicture = {
  ...TAJ,
  assetId: "01JPX0000000000000000000C1",
  tags: ["masala chai"],
  title: "A cup of masala chai",
  source: "pexels",
  credit: {
    provider: "pexels",
    photographer: "Asha Rao",
    photographerUrl: "https://www.pexels.com/@asha-rao",
    pageUrl: "https://www.pexels.com/photo/1181/",
  },
};

function library(overrides: Partial<LibraryResponse> = {}): LibraryResponse {
  return {
    items: [TAJ, CHAI],
    stock: { enabled: false, provider: null },
    limits: LIMITS,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function calls(fetchMock: ReturnType<typeof vi.fn>, method: string, path: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      new URL(String(input)).pathname === path &&
      ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );
}

describe("<BrollLibraryView />", () => {
  it("lists every picture with its tags and a stock photo's credit, and no stock search without a key", async () => {
    renderWithProviders(<BrollLibraryView />, { routes: { "/broll": library() } });
    expect(await screen.findByTestId("broll-status")).toHaveTextContent("2 of 300 pictures");
    expect(screen.getByTestId(`broll-tags-${TAJ.assetId}`)).toHaveValue("taj mahal, agra");
    const chai = screen.getByTestId(`broll-picture-${CHAI.assetId}`);
    expect(within(chai).getByText("Asha Rao")).toHaveAttribute(
      "href",
      "https://www.pexels.com/@asha-rao",
    );
    expect(screen.queryByTestId("broll-stock")).not.toBeInTheDocument();
    // One primary action on the page.
    expect(screen.getByTestId("broll-upload")).toBeEnabled();
  });

  it("uploads a picture through a signed PUT, tagged from its file's name", async () => {
    const picture = { ...TAJ, assetId: "01JPX0000000000000000000N1" };
    // The bytes go straight to storage, not through the API client.
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);
    const { fetchMock } = renderWithProviders(<BrollLibraryView />, {
      routes: {
        "/broll": library(),
        "/broll/uploads": {
          assetId: picture.assetId,
          uploadUrl: "https://store.test/put-here",
          contentType: "image/jpeg",
          expiresAt: "2026-10-05T10:00:00.000Z",
          maxBytes: LIMITS.maxBytes,
        },
        [`/broll/${picture.assetId}/complete`]: picture,
      },
    });
    await screen.findByTestId("broll-status");
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "Gateway-of-India.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(screen.getByTestId("broll-upload-input"), { target: { files: [file] } });

    await waitFor(() => {
      expect(calls(fetchMock, "POST", `/broll/${picture.assetId}/complete`)).toHaveLength(1);
    });
    expect(put).toHaveBeenCalledWith(
      "https://store.test/put-here",
      expect.objectContaining({ method: "PUT", headers: { "Content-Type": "image/jpeg" } }),
    );
    const [, init] = calls(fetchMock, "POST", `/broll/${picture.assetId}/complete`)[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      contentType: "image/jpeg",
      tags: ["gateway of india"],
      title: "Gateway-of-India",
    });
  });

  it("refuses a file that is not a picture before sending anything", async () => {
    const { fetchMock } = renderWithProviders(<BrollLibraryView />, {
      routes: { "/broll": library() },
    });
    await screen.findByTestId("broll-status");
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("broll-upload-input"), { target: { files: [file] } });
    expect(await screen.findByTestId("broll-error")).toHaveTextContent("JPEG, PNG or WebP");
    expect(calls(fetchMock, "POST", "/broll/uploads")).toHaveLength(0);
  });

  it("saves a picture's tags, trimmed and lower-cased", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<BrollLibraryView />, {
      routes: { "/broll": library(), [`/broll/${TAJ.assetId}`]: TAJ },
    });
    const input = await screen.findByTestId(`broll-tags-${TAJ.assetId}`);
    const save = screen.getByTestId(`broll-tags-save-${TAJ.assetId}`);
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, " Taj Mahal ,  Yamuna ");
    await user.click(save);
    await waitFor(() => {
      expect(calls(fetchMock, "PATCH", `/broll/${TAJ.assetId}`)).toHaveLength(1);
    });
    const [, init] = calls(fetchMock, "PATCH", `/broll/${TAJ.assetId}`)[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      tags: ["taj mahal", "yamuna"],
    });
  });

  it("deletes a picture only once it is confirmed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<BrollLibraryView />, {
      routes: { "/broll": library(), [`/broll/${TAJ.assetId}`]: { deleted: true } },
    });
    await user.click(await screen.findByTestId(`broll-delete-${TAJ.assetId}`));
    expect(calls(fetchMock, "DELETE", `/broll/${TAJ.assetId}`)).toHaveLength(0);
    await user.click(screen.getByTestId(`broll-delete-confirm-${TAJ.assetId}`));
    await waitFor(() => {
      expect(calls(fetchMock, "DELETE", `/broll/${TAJ.assetId}`)).toHaveLength(1);
    });
  });

  it("searches stock photos when the deployment has them, and keeps one tagged with the search", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<BrollLibraryView />, {
      routes: {
        "/broll": library({ stock: { enabled: true, provider: "pexels" } }),
        "/broll/stock": {
          provider: "pexels",
          query: "masala chai",
          page: 1,
          photos: [
            {
              id: 1181,
              width: 3000,
              height: 4500,
              alt: "A cup of tea",
              photographer: "Asha Rao",
              photographerUrl: "https://www.pexels.com/@asha-rao",
              pageUrl: "https://www.pexels.com/photo/1181/",
              previewUrl: "https://images.pexels.com/photos/1181/p.jpeg?h=350",
            },
          ],
        },
      },
    });
    await user.type(await screen.findByTestId("broll-stock-query"), "Masala Chai");
    await user.click(screen.getByTestId("broll-stock-search"));
    const add = await screen.findByTestId("broll-stock-add-1181");
    const search = calls(fetchMock, "GET", "/broll/stock")[0]?.[0];
    expect(new URL(String(search)).searchParams.get("orientation")).toBe("portrait");
    await user.click(add);
    await waitFor(() => {
      expect(calls(fetchMock, "POST", "/broll/stock")).toHaveLength(1);
    });
    const [, init] = calls(fetchMock, "POST", "/broll/stock")[0] ?? [];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      photoId: 1181,
      tags: ["masala chai"],
    });
    expect(
      screen.getByText("Pexels", { selector: "a[href='https://www.pexels.com']" }),
    ).toBeInTheDocument();
  });

  it("lets a viewer look but not change anything", async () => {
    renderWithProviders(<BrollLibraryView />, {
      routes: { "/broll": library() },
      accessToken: testAccessToken({ role: "viewer" }),
    });
    expect(await screen.findByTestId("broll-status")).toHaveTextContent("Only editors");
    expect(screen.getByTestId("broll-upload")).toBeDisabled();
    expect(screen.getByTestId(`broll-delete-${TAJ.assetId}`)).toBeDisabled();
  });
});
