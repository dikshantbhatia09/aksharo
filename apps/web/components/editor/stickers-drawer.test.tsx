import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StickersDrawer } from "./stickers-drawer";

// Mock @montaj/api-client
vi.mock("@montaj/api-client", () => ({
  defineEndpoint: vi.fn((opts) => opts),
  isApiError: vi.fn(() => false),
  useApiClient: vi.fn(() => ({
    call: vi.fn().mockImplementation((endpoint, opts) => {
      const path = endpoint?.path ?? "";
      if (path.includes("/stickers/categories")) {
        return Promise.resolve({
          categories: ["All", "Shocked Reactions", "Arrows & Pointers", "Viral Memes"],
        });
      }
      if (path.includes("/stickers/trending") || path.includes("/stickers/search")) {
        return Promise.resolve({
          assets: [
            {
              id: "meme-confused-nick-young",
              provider: "curated",
              type: "meme",
              title: "Confused Nick Young (Question Marks)",
              url: "https://media.giphy.com/media/lkdH8FmImcGoykgFPM/giphy.gif",
              previewUrl: "https://media.giphy.com/media/lkdH8FmImcGoykgFPM/giphy-preview.webp",
              width: 480,
              height: 480,
              isTransparent: false,
              tags: ["confused", "meme"],
            },
            {
              id: "sticker-animated-red-arrow",
              provider: "curated",
              type: "sticker",
              title: "Animated Glowing Red Pointer Arrow",
              url: "https://media.giphy.com/media/v1/5GoVLqeAOo6PK/giphy.gif",
              previewUrl: "https://media.giphy.com/media/v1/5GoVLqeAOo6PK/giphy-preview.webp",
              width: 400,
              height: 400,
              isTransparent: true,
              tags: ["arrow", "pointer"],
            },
          ],
          total: 2,
          page: 1,
          limit: 28,
          categories: ["All", "Shocked Reactions", "Arrows & Pointers", "Viral Memes"],
        });
      }
      if (path.includes("/stickers/recommend")) {
        return Promise.resolve({
          recommendations: [
            {
              sticker: {
                id: "meme-shocked-steve-harvey",
                provider: "curated",
                type: "meme",
                title: "Shocked Steve Harvey Stare",
                url: "https://media.giphy.com/media/l4Ho0Mx46slQVPe1i/giphy.gif",
                previewUrl: "https://media.giphy.com/media/l4Ho0Mx46slQVPe1i/giphy-preview.webp",
                width: 480,
                height: 270,
                isTransparent: false,
                tags: ["shocked"],
              },
              reason: "Unbelievable moment detected in speech",
              sentiment: "shocked",
            },
          ],
        });
      }
      if (path.includes("/stickers/cache")) {
        return Promise.resolve({
          cachedKey: "stickers/curated/arrow.webm",
          cachedUrl: "https://assets.aksharo.com/stickers/curated/arrow.webm",
          isTransparent: true,
          format: "webm",
          sizeBytes: 1024,
        });
      }
      return Promise.resolve({});
    }),
  })),
}));

describe("<StickersDrawer />", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  const renderComponent = (props: React.ComponentProps<typeof StickersDrawer> = {}) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <StickersDrawer {...props} />
      </QueryClientProvider>,
    );
  };

  it("renders header, search bar, and category filter pills", async () => {
    renderComponent();

    expect(screen.getByText("Stickers, GIFs & Memes")).toBeDefined();
    expect(screen.getByTestId("stickers-search-input")).toBeDefined();
    expect(screen.getByTestId("stickers-ai-recommend-button")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId("stickers-category-all")).toBeDefined();
    });
  });

  it("displays assets in the grid and handles category selection", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByTestId("sticker-card-meme-confused-nick-young")).toBeDefined();
      expect(screen.getByTestId("sticker-card-sticker-animated-red-arrow")).toBeDefined();
    });

    const categoryBtn = screen.getByTestId("stickers-category-arrows-&-pointers");
    fireEvent.click(categoryBtn);

    const input = screen.getByTestId("stickers-search-input") as HTMLInputElement;
    expect(input.value).toBe("Arrows & Pointers");
  });

  it("triggers AI contextual reaction meme recommendations on click", async () => {
    renderComponent({ transcriptText: "That was completely insane and crazy" });

    const aiBtn = screen.getByTestId("stickers-ai-recommend-button");
    fireEvent.click(aiBtn);

    await waitFor(() => {
      expect(screen.getByTestId("stickers-ai-recommendations-panel")).toBeDefined();
      expect(screen.getByTestId("stickers-ai-item-meme-shocked-steve-harvey")).toBeDefined();
    });
  });

  it("calls onInsertSticker when a sticker card is clicked", async () => {
    const onInsertSticker = vi.fn();
    renderComponent({ onInsertSticker });

    await waitFor(() => {
      expect(screen.getByTestId("sticker-card-sticker-animated-red-arrow")).toBeDefined();
    });

    const card = screen.getByTestId("sticker-card-sticker-animated-red-arrow");
    fireEvent.click(card);

    await waitFor(() => {
      expect(onInsertSticker).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sticker-animated-red-arrow",
        }),
        expect.any(String),
      );
    });
  });
});
