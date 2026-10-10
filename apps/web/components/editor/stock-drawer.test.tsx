import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { StockDrawer } from "./stock-drawer";

// Mock @montaj/api-client
vi.mock("@montaj/api-client", () => ({
  defineEndpoint: vi.fn((opts) => opts),
  isApiError: vi.fn(() => false),
  useApiClient: vi.fn(() => ({
    call: vi.fn().mockImplementation((endpoint) => {
      if (endpoint.path === "/stock/categories") {
        return Promise.resolve({
          categories: ["All", "Technology", "Business", "Nature", "City", "Finance"],
        });
      }
      if (endpoint.path === "/stock/search") {
        return Promise.resolve({
          items: [
            {
              id: "sb-tech-ai-01",
              provider: "storyblocks",
              title: "Artificial Intelligence Glowing Neural Network Nodes",
              durationSec: 8.0,
              thumbnailUrl: "https://assets.aksharo.com/stock/previews/ai-neural-network.jpg",
              previewVideoUrl: "https://assets.aksharo.com/stock/videos/ai-neural-network-preview-480p.mp4",
              downloadVideoUrl: "https://assets.aksharo.com/stock/videos/ai-neural-network-vertical-1080p.mp4",
              width: 1080,
              height: 1920,
              authorName: "NeuralFx",
              resolution: "1080p",
              aspectRatio: "9:16",
              tags: ["technology", "ai"],
            },
            {
              id: "sb-crypto-chart-02",
              provider: "storyblocks",
              title: "Cryptocurrency Candlestick Market Growth Bull Run",
              durationSec: 6.8,
              thumbnailUrl: "https://assets.aksharo.com/stock/previews/stock-market-charts.jpg",
              previewVideoUrl: "https://assets.aksharo.com/stock/videos/stock-market-charts-preview-480p.mp4",
              downloadVideoUrl: "https://assets.aksharo.com/stock/videos/stock-market-charts-vertical-1080p.mp4",
              width: 1080,
              height: 1920,
              authorName: "QuantVisuals",
              resolution: "1080p",
              aspectRatio: "9:16",
              tags: ["finance", "crypto"],
            },
          ],
          total: 2,
          page: 1,
          perPage: 20,
          cached: false,
        });
      }
      if (endpoint.path === "/stock/import") {
        return Promise.resolve({
          assetId: "sb-tech-ai-01",
          provider: "storyblocks",
          cachedKey: "stock-cache/storyblocks/sb-tech-ai-01.mp4",
          cachedUrl: "https://s3.aksharo.com/stock-cache/storyblocks/sb-tech-ai-01.mp4",
          sizeBytes: 8_500_000,
          status: "ready",
        });
      }
      return Promise.resolve({});
    }),
  })),
  useWorkspaceId: vi.fn(() => "ws-test-123"),
}));

function renderStockDrawer(props: React.ComponentProps<typeof StockDrawer> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <StockDrawer {...props} />
    </QueryClientProvider>,
  );
}

describe("<StockDrawer />", () => {
  it("renders search input, category chips, and orientation buttons", async () => {
    renderStockDrawer();

    expect(screen.getByTestId("stock-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("stock-search-input")).toBeInTheDocument();
    expect(screen.getByTestId("orientation-portrait-btn")).toBeInTheDocument();
    expect(screen.getByTestId("orientation-landscape-btn")).toBeInTheDocument();
    expect(screen.getByTestId("orientation-all-btn")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("category-chip-all")).toBeInTheDocument();
      expect(screen.getByTestId("category-chip-technology")).toBeInTheDocument();
    });
  });

  it("renders stock media cards with resolution, duration, and provider badges", async () => {
    renderStockDrawer();

    await waitFor(() => {
      expect(screen.getByTestId("stock-card-sb-tech-ai-01")).toBeInTheDocument();
      expect(screen.getByTestId("stock-card-sb-crypto-chart-02")).toBeInTheDocument();
    });

    expect(screen.getByText("8.0s")).toBeInTheDocument();
    expect(screen.getAllByText("1080p").length).toBeGreaterThanOrEqual(1);
  });

  it("plays video preview on hover (mouseEnter / mouseLeave)", async () => {
    renderStockDrawer();

    await waitFor(() => {
      expect(screen.getByTestId("stock-card-sb-tech-ai-01")).toBeInTheDocument();
    });

    const card = screen.getByTestId("stock-card-sb-tech-ai-01");

    // Before hover, video preview element should not be rendered
    expect(screen.queryByTestId("stock-preview-video-sb-tech-ai-01")).toBeNull();

    // Mouse enter triggers hover preview
    fireEvent.mouseEnter(card);
    expect(screen.getByTestId("stock-preview-video-sb-tech-ai-01")).toBeInTheDocument();

    // Mouse leave removes preview
    fireEvent.mouseLeave(card);
    expect(screen.queryByTestId("stock-preview-video-sb-tech-ai-01")).toBeNull();
  });

  it("handles inserting clip and calls onInsertAsset callback", async () => {
    const user = userEvent.setup();
    const onInsertAsset = vi.fn();
    renderStockDrawer({ onInsertAsset });

    await waitFor(() => {
      expect(screen.getByTestId("stock-insert-btn-sb-tech-ai-01")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("stock-insert-btn-sb-tech-ai-01"));

    await waitFor(() => {
      expect(onInsertAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sb-tech-ai-01",
          provider: "storyblocks",
        }),
        expect.stringContaining("https://s3.aksharo.com/stock-cache/storyblocks/sb-tech-ai-01.mp4"),
      );
    });
  });

  it("switches orientation toggle on click", async () => {
    const user = userEvent.setup();
    renderStockDrawer();

    const landscapeBtn = screen.getByTestId("orientation-landscape-btn");
    await user.click(landscapeBtn);

    expect(landscapeBtn).toHaveClass("bg-accent");
  });
});
