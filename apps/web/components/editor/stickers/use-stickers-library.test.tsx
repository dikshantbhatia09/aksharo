import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_STICKER_ITEMS,
  useStickersCategories,
  useStickersSearch,
  useStickersTrending,
} from "./use-stickers-library";

// Mock @montaj/api-client
vi.mock("@montaj/api-client", () => ({
  defineEndpoint: vi.fn((opts) => opts),
  isApiError: vi.fn(() => false),
  useApiClient: vi.fn(() => ({
    call: vi.fn().mockImplementation((endpoint) => {
      const path = endpoint?.path ?? "";
      if (path.includes("/stickers/categories")) {
        return Promise.resolve({
          categories: ["All", "Shocked Reactions", "Arrows & Pointers", "Viral Memes"],
        });
      }
      if (path.includes("/stickers/search")) {
        return Promise.resolve({
          assets: FALLBACK_STICKER_ITEMS,
          total: FALLBACK_STICKER_ITEMS.length,
          page: 1,
          limit: 24,
          categories: ["All", "Shocked Reactions", "Arrows & Pointers"],
        });
      }
      if (path.includes("/stickers/trending")) {
        return Promise.resolve({
          assets: FALLBACK_STICKER_ITEMS.slice(0, 4),
          total: 4,
          page: 1,
          limit: 4,
          categories: ["All"],
        });
      }
      return Promise.resolve({});
    }),
  })),
}));

describe("use-stickers-library", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("useStickersSearch fetches items matching query", async () => {
    const { result } = renderHook(() => useStickersSearch({ query: "arrow" }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.assets.length).toBeGreaterThan(0);
    expect(result.current.data?.total).toBe(FALLBACK_STICKER_ITEMS.length);
  });

  it("useStickersTrending fetches trending assets", async () => {
    const { result } = renderHook(() => useStickersTrending("all"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.assets.length).toBe(4);
  });

  it("useStickersCategories returns category list", async () => {
    const { result } = renderHook(() => useStickersCategories(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.categories).toContain("Shocked Reactions");
  });
});
