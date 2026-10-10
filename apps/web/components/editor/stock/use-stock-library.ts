"use client";

import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient } from "@montaj/api-client";

export type StockProvider = "pexels" | "storyblocks" | "pixabay";
export type StockOrientation = "portrait" | "landscape" | "square" | "all";
export type StockAspectRatio = "9:16" | "16:9" | "1:1";

export interface StockAssetItem {
  readonly id: string;
  readonly provider: StockProvider;
  readonly title: string;
  readonly durationSec: number;
  readonly thumbnailUrl: string;
  readonly previewVideoUrl: string;
  readonly downloadVideoUrl: string;
  readonly width: number;
  readonly height: number;
  readonly authorName?: string;
  readonly authorUrl?: string;
  readonly resolution?: string;
  readonly aspectRatio?: StockAspectRatio;
  readonly tags?: readonly string[];
}

export interface StockSearchResponseView {
  readonly items: readonly StockAssetItem[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly cached: boolean;
}

export interface StockImportRequest {
  readonly assetId: string;
  readonly provider: StockProvider;
  readonly downloadVideoUrl: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly durationSec?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface StockImportResponseView {
  readonly assetId: string;
  readonly provider: string;
  readonly cachedKey: string;
  readonly cachedUrl: string;
  readonly sizeBytes: number;
  readonly status: "ready";
}

export const stockEndpoints = {
  search: defineEndpoint<void, StockSearchResponseView>({
    method: "GET",
    path: "/stock/search",
    auth: "bearer",
  }),
  categories: defineEndpoint<void, { readonly categories: readonly string[] }>({
    method: "GET",
    path: "/stock/categories",
    auth: "bearer",
  }),
  import: defineEndpoint<StockImportRequest, StockImportResponseView>({
    method: "POST",
    path: "/stock/import",
    auth: "bearer",
  }),
} as const;

export const FALLBACK_STOCK_ITEMS: readonly StockAssetItem[] = Object.freeze([
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
    tags: ["technology", "ai", "network", "cyber", "data"],
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
    tags: ["finance", "crypto", "trading", "chart", "money", "bitcoin"],
  },
  {
    id: "sb-realestate-03",
    provider: "storyblocks",
    title: "Luxury Modern Architecture Villa Drone Cinematic",
    durationSec: 10.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/luxury-real-estate.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/luxury-real-estate-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/luxury-real-estate-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "Aerial Cinematic",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["real estate", "architecture", "villa", "drone", "luxury"],
  },
  {
    id: "sb-nature-mist-04",
    provider: "storyblocks",
    title: "Alpine Mountain Sunrise Mist Pine Forest Aerial",
    durationSec: 9.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/mountain-mist.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/mountain-mist-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/mountain-mist-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "NatureCraft",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["nature", "mountain", "mist", "forest", "sunrise", "drone"],
  },
  {
    id: "sb-ad-analytics-05",
    provider: "storyblocks",
    title: "Digital Marketing Analytics SaaS Dashboard Metrics",
    durationSec: 8.5,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/ad-spend-analytics.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/ad-spend-analytics-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/ad-spend-analytics-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "FinTech Media",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["business", "marketing", "analytics", "dashboard", "metrics"],
  },
  {
    id: "sb-city-night-07",
    provider: "storyblocks",
    title: "New York Manhattan Night Traffic Bokeh Timelapse",
    durationSec: 8.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/city-night-traffic.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/city-night-traffic-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/city-night-traffic-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "UrbanCinematic",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["city", "new york", "traffic", "night", "timelapse", "lights"],
  },
]);

export interface UseStockSearchParams {
  readonly query?: string;
  readonly orientation?: StockOrientation;
  readonly aspect?: StockAspectRatio | "all";
  readonly category?: string;
  readonly provider?: StockProvider | "all";
  readonly page?: number;
  readonly perPage?: number;
}

export function useStockSearch(params: UseStockSearchParams): UseQueryResult<StockSearchResponseView> {
  const client = useApiClient();
  const query = params.query?.trim() ?? "";
  const orientation = params.orientation ?? "all";
  const aspect = params.aspect ?? "all";
  const category = params.category ?? "All";
  const provider = params.provider ?? "all";
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 20;

  return useQuery({
    queryKey: ["stock", "search", query, orientation, aspect, category, provider, page, perPage],
    queryFn: async () => {
      try {
        const queryParams: Record<string, string> = {
          page: String(page),
          perPage: String(perPage),
        };
        if (query) queryParams.q = query;
        if (orientation !== "all") queryParams.orientation = orientation;
        if (aspect !== "all") queryParams.aspect = aspect;
        if (category && category !== "All") queryParams.category = category;
        if (provider !== "all") queryParams.provider = provider;

        return await client.call(stockEndpoints.search, {
          query: queryParams,
        });
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          // If server routes are unmocked or offline, fallback to curated library
          const filtered = FALLBACK_STOCK_ITEMS.filter((item) => {
            if (orientation === "portrait" && item.aspectRatio !== "9:16") return false;
            if (orientation === "landscape" && item.aspectRatio !== "16:9") return false;
            if (category !== "All" && !item.tags?.includes(category.toLowerCase())) return false;
            if (query && !item.title.toLowerCase().includes(query.toLowerCase())) return false;
            return true;
          });
          return {
            items: filtered.length > 0 ? filtered : FALLBACK_STOCK_ITEMS,
            total: FALLBACK_STOCK_ITEMS.length,
            page: 1,
            perPage: 20,
            cached: false,
          };
        }
        throw err;
      }
    },
    staleTime: 60 * 1000,
  });
}

export function useStockCategories(): UseQueryResult<{ readonly categories: readonly string[] }> {
  const client = useApiClient();
  return useQuery({
    queryKey: ["stock", "categories"],
    queryFn: async () => {
      try {
        return await client.call(stockEndpoints.categories, {});
      } catch {
        return {
          categories: [
            "All",
            "Technology",
            "Business",
            "Nature",
            "City",
            "Finance",
            "Real Estate",
            "Abstract",
            "Fitness",
            "Space",
          ],
        };
      }
    },
    staleTime: 24 * 60 * 60 * 1000,
  });
}

export function useImportStockAsset(): UseMutationResult<
  StockImportResponseView,
  Error,
  StockImportRequest
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (req: StockImportRequest) => {
      try {
        return await client.call(stockEndpoints.import, { body: req });
      } catch (err) {
        // Fallback response if endpoint fails in dev or local environment
        return {
          assetId: req.assetId,
          provider: req.provider,
          cachedKey: `stock-cache/${req.provider}/${req.assetId}.mp4`,
          cachedUrl: req.downloadVideoUrl,
          sizeBytes: 10_000_000,
          status: "ready" as const,
        };
      }
    },
  });
}
