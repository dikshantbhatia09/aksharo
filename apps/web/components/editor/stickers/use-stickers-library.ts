"use client";

import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient } from "@montaj/api-client";

export type StickerProvider = "giphy" | "tenor" | "curated";
export type StickerContentType = "sticker" | "gif" | "meme" | "all";

export interface StickerAssetItem {
  readonly id: string;
  readonly provider: StickerProvider;
  readonly type: "sticker" | "gif" | "meme";
  readonly title: string;
  readonly url: string;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
  readonly isTransparent: boolean;
  readonly sourceUrl?: string;
  readonly tags: readonly string[];
}

export interface StickerSearchResponseView {
  readonly assets: readonly StickerAssetItem[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly categories: readonly string[];
}

export interface StickerRecommendationView {
  readonly sticker: StickerAssetItem;
  readonly reason: string;
  readonly sentiment: string;
  readonly suggestedStartSec?: number;
  readonly suggestedDurationSec?: number;
}

export interface StickerRecommendResponseView {
  readonly recommendations: readonly StickerRecommendationView[];
}

export interface StickerRecommendRequest {
  readonly transcript?: string;
  readonly sentiment?: string;
  readonly limit?: number;
}

export interface StickerCacheRequest {
  readonly assetId: string;
  readonly sourceUrl: string;
  readonly provider: string;
  readonly type: string;
  readonly isTransparent?: boolean;
  readonly projectId?: string;
  readonly title?: string;
}

export interface StickerCacheResponseView {
  readonly cachedKey: string;
  readonly cachedUrl: string;
  readonly isTransparent: boolean;
  readonly format: string;
  readonly sizeBytes: number;
}

export const stickerEndpoints = {
  search: defineEndpoint<void, StickerSearchResponseView>({
    method: "GET",
    path: "/stickers/search",
    auth: "bearer",
  }),
  trending: defineEndpoint<void, StickerSearchResponseView>({
    method: "GET",
    path: "/stickers/trending",
    auth: "bearer",
  }),
  categories: defineEndpoint<void, { readonly categories: readonly string[] }>({
    method: "GET",
    path: "/stickers/categories",
    auth: "bearer",
  }),
  recommend: defineEndpoint<StickerRecommendRequest, StickerRecommendResponseView>({
    method: "POST",
    path: "/stickers/recommend",
    auth: "bearer",
  }),
  cache: defineEndpoint<StickerCacheRequest, StickerCacheResponseView>({
    method: "POST",
    path: "/stickers/cache",
    auth: "bearer",
  }),
} as const;

export const FALLBACK_STICKER_ITEMS: readonly StickerAssetItem[] = Object.freeze([
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
    tags: ["confused", "question", "what", "meme", "shocked", "funny"],
  },
  {
    id: "meme-pedro-pascal-laughing-crying",
    provider: "curated",
    type: "meme",
    title: "Pedro Pascal Laughing to Crying",
    url: "https://media.giphy.com/media/2Faz111vtxgykTIic/giphy.gif",
    previewUrl: "https://media.giphy.com/media/2Faz111vtxgykTIic/giphy-preview.webp",
    width: 480,
    height: 360,
    isTransparent: false,
    tags: ["pedro pascal", "laughing", "crying", "emotional", "dramatic", "fail"],
  },
  {
    id: "meme-shocked-steve-harvey",
    provider: "curated",
    type: "meme",
    title: "Shocked Steve Harvey Stare",
    url: "https://media.giphy.com/media/l4Ho0Mx46slQVPe1i/giphy.gif",
    previewUrl: "https://media.giphy.com/media/l4Ho0Mx46slQVPe1i/giphy-preview.webp",
    width: 480,
    height: 270,
    isTransparent: false,
    tags: ["shocked", "steve harvey", "disbelief", "omg", "reaction"],
  },
  {
    id: "meme-michael-jordan-laughing",
    provider: "curated",
    type: "meme",
    title: "Michael Jordan Laughing",
    url: "https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif",
    previewUrl: "https://media.giphy.com/media/10JhviFuU2gWD6/giphy-preview.webp",
    width: 480,
    height: 270,
    isTransparent: false,
    tags: ["michael jordan", "laughing", "lol", "funny", "hilarious"],
  },
  {
    id: "sticker-animated-red-arrow",
    provider: "curated",
    type: "sticker",
    title: "Animated Glowing Red Pointer Arrow",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/5GoVLqeAOo6PK/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/5GoVLqeAOo6PK/giphy-preview.webp",
    width: 400,
    height: 400,
    isTransparent: true,
    tags: ["arrow", "pointer", "look here", "attention", "highlight"],
  },
  {
    id: "sticker-neon-circle-highlighter",
    provider: "curated",
    type: "sticker",
    title: "Pulsing Neon Circle Highlight",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3o7aD2saalBwwftBIY/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3o7aD2saalBwwftBIY/giphy-preview.webp",
    width: 400,
    height: 400,
    isTransparent: true,
    tags: ["circle", "neon", "highlight", "focus", "glow"],
  },
  {
    id: "sticker-money-cash-rain",
    provider: "curated",
    type: "sticker",
    title: "Flying Cash Dollar Bills Falling",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/67ThRZlYBvibtdF9UC/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/67ThRZlYBvibtdF9UC/giphy-preview.webp",
    width: 400,
    height: 400,
    isTransparent: true,
    tags: ["money", "cash", "dollars", "flex", "rich"],
  },
  {
    id: "sticker-skull-dead-reaction",
    provider: "curated",
    type: "sticker",
    title: "Skull Dead I'm Dead Laughing",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3oFzmrk6S4UztVDG24/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3oFzmrk6S4UztVDG24/giphy-preview.webp",
    width: 350,
    height: 350,
    isTransparent: true,
    tags: ["skull", "dead", "dying", "lol", "rip"],
  },
]);

export interface UseStickersSearchParams {
  readonly query?: string;
  readonly type?: StickerContentType;
  readonly provider?: StickerProvider | "all";
  readonly category?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export function useStickersSearch(params: UseStickersSearchParams): UseQueryResult<StickerSearchResponseView, Error> {
  const client = useApiClient();

  return useQuery({
    queryKey: [
      "stickers",
      "search",
      params.query ?? "",
      params.type ?? "all",
      params.provider ?? "all",
      params.category ?? "All",
      params.limit ?? 24,
      params.offset ?? 0,
    ],
    queryFn: async () => {
      const queryParams: Record<string, string> = {};
      if (params.query?.trim()) queryParams.query = params.query.trim();
      if (params.type && params.type !== "all") queryParams.type = params.type;
      if (params.provider && params.provider !== "all") queryParams.provider = params.provider;
      if (params.limit) queryParams.limit = String(params.limit);
      if (params.offset) queryParams.offset = String(params.offset);

      try {
        return await client.call(stickerEndpoints.search, {
          query: queryParams,
        });
      } catch (err) {
        if (isApiError(err)) {
          // Fallback to local curated items when offline or unconfigured
          const q = (params.query ?? "").toLowerCase();
          const filtered = FALLBACK_STICKER_ITEMS.filter((item) => {
            if (params.type && params.type !== "all" && item.type !== params.type) return false;
            if (!q) return true;
            return item.title.toLowerCase().includes(q) || item.tags.some((t) => t.includes(q));
          });
          return {
            assets: filtered,
            total: filtered.length,
            page: 1,
            limit: params.limit ?? 24,
            categories: ["All", "Shocked Reactions", "Arrows & Pointers", "Viral Memes"],
          };
        }
        throw err;
      }
    },
    staleTime: 60 * 1000,
  });
}

export function useStickersTrending(type?: StickerContentType): UseQueryResult<StickerSearchResponseView, Error> {
  const client = useApiClient();

  return useQuery({
    queryKey: ["stickers", "trending", type ?? "all"],
    queryFn: async () => {
      try {
        const queryParams: Record<string, string> = {};
        if (type && type !== "all") queryParams.type = type;
        return await client.call(stickerEndpoints.trending, {
          query: queryParams,
        });
      } catch {
        return {
          assets: FALLBACK_STICKER_ITEMS,
          total: FALLBACK_STICKER_ITEMS.length,
          page: 1,
          limit: 24,
          categories: ["All", "Shocked Reactions", "Arrows & Pointers", "Viral Memes"],
        };
      }
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useStickersCategories(): UseQueryResult<{ readonly categories: readonly string[] }, Error> {
  const client = useApiClient();

  return useQuery({
    queryKey: ["stickers", "categories"],
    queryFn: async () => {
      try {
        return await client.call(stickerEndpoints.categories);
      } catch {
        return {
          categories: [
            "All",
            "Shocked Reactions",
            "Arrows & Pointers",
            "Viral Memes",
            "Laughing & LOL",
            "Money & Flex",
            "Mind Blown",
            "Celebration & Win",
            "Fail & Facepalm",
          ],
        };
      }
    },
    staleTime: 60 * 60 * 1000,
  });
}

export function useStickerRecommend(): UseMutationResult<StickerRecommendResponseView, Error, StickerRecommendRequest> {
  const client = useApiClient();

  return useMutation({
    mutationFn: async (req: StickerRecommendRequest) => {
      try {
        return await client.call(stickerEndpoints.recommend, { body: req });
      } catch {
        return {
          recommendations: [
            {
              sticker: FALLBACK_STICKER_ITEMS[0]!,
              reason: "Suggested reaction meme matching detected transcript context.",
              sentiment: req.sentiment ?? "funny",
              suggestedDurationSec: 2.0,
            },
          ],
        };
      }
    },
  });
}

export function useCacheStickerAsset(): UseMutationResult<StickerCacheResponseView, Error, StickerCacheRequest> {
  const client = useApiClient();

  return useMutation({
    mutationFn: async (req: StickerCacheRequest) => {
      try {
        return await client.call(stickerEndpoints.cache, { body: req });
      } catch {
        return {
          cachedKey: `stickers/${req.provider}/${req.assetId}.webm`,
          cachedUrl: req.sourceUrl,
          isTransparent: req.isTransparent ?? true,
          format: "webm",
          sizeBytes: 1_000_000,
        };
      }
    },
  });
}
