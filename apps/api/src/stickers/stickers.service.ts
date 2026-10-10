import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { z } from "zod";

import {
  STICKER_CATEGORIES,
  type StickerCacheDto,
  type StickerCacheResponse,
  type StickerContentType,
  type StickerItem,
  type StickerRecommendation,
  type StickerRecommendDto,
  type StickerRecommendResponse,
  type StickerSearchQueryDto,
  type StickerSearchResponse,
  type StickerTrendingQueryDto,
} from "./stickers.dto.js";
import { AppException, PrismaService } from "../common/index.js";
import { safeFetch } from "../common/net/index.js";
import { RedisService } from "../common/redis/redis.service.js";
import { RAW_STORE, type ObjectStore } from "../common/storage/object-store.js";

export const REDIS_STICKER_CACHE_TTL_SEC = 48 * 60 * 60; // 48-hour cache TTL
const PROVIDER_TIMEOUT_MS = 6_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// Giphy API schemas
const GiphyImageItemSchema = z.object({
  url: z.string().url().optional(),
  webp: z.string().url().optional(),
  width: z.string().optional(),
  height: z.string().optional(),
  size: z.string().optional(),
});

const GiphyAssetSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  is_sticker: z.number().optional(),
  images: z.object({
    original: GiphyImageItemSchema.optional(),
    fixed_height: GiphyImageItemSchema.optional(),
    fixed_height_small: GiphyImageItemSchema.optional(),
    preview_gif: GiphyImageItemSchema.optional(),
  }),
});

const GiphySearchResponseSchema = z.object({
  data: z.array(GiphyAssetSchema),
  pagination: z
    .object({
      total_count: z.number().optional(),
      count: z.number().optional(),
      offset: z.number().optional(),
    })
    .optional(),
});

// Tenor API schemas
const TenorMediaFormatSchema = z.object({
  url: z.string().url(),
  dims: z.array(z.number()).optional(),
  duration: z.number().optional(),
  size: z.number().optional(),
});

const TenorResultSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  content_description: z.string().optional(),
  itemurl: z.string().optional(),
  media_formats: z.object({
    gif: TenorMediaFormatSchema.optional(),
    tinygif: TenorMediaFormatSchema.optional(),
    webm: TenorMediaFormatSchema.optional(),
    mp4: TenorMediaFormatSchema.optional(),
  }),
  tags: z.array(z.string()).optional(),
});

const TenorSearchResponseSchema = z.object({
  results: z.array(TenorResultSchema),
  next: z.string().optional(),
});

/**
 * Curated iconic meme & sticker catalog.
 * Guarantees ultra-reliable, zero-latency (<= 450ms SLA) responses even when offline
 * or if external API keys (GIPHY_API_KEY / TENOR_API_KEY) are absent.
 */
export const CURATED_STICKERS_MEMES_LIBRARY: readonly StickerItem[] = Object.freeze([
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
    tags: ["shocked", "steve harvey", "disbelief", "omg", "jaw drop", "reaction"],
  },
  {
    id: "meme-michael-jordan-laughing",
    provider: "curated",
    type: "meme",
    title: "Michael Jordan Laughing (The Last Dance)",
    url: "https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif",
    previewUrl: "https://media.giphy.com/media/10JhviFuU2gWD6/giphy-preview.webp",
    width: 480,
    height: 270,
    isTransparent: false,
    tags: ["michael jordan", "laughing", "lol", "funny", "hilarious", "joke"],
  },
  {
    id: "meme-mind-blown-tim-and-eric",
    provider: "curated",
    type: "meme",
    title: "Mind Blown Galaxy Head Explosion",
    url: "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif",
    previewUrl: "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy-preview.webp",
    width: 480,
    height: 360,
    isTransparent: false,
    tags: ["mind blown", "explosion", "genius", "crazy", "astronomy", "insane"],
  },
  {
    id: "meme-leonardo-dicaprio-toast",
    provider: "curated",
    type: "meme",
    title: "Leonardo DiCaprio Gatsby Champagne Toast",
    url: "https://media.giphy.com/media/GCLlQnV7dXY2KGmpZO/giphy.gif",
    previewUrl: "https://media.giphy.com/media/GCLlQnV7dXY2KGmpZO/giphy-preview.webp",
    width: 480,
    height: 270,
    isTransparent: false,
    tags: ["celebrate", "win", "cheers", "gatsby", "success", "congrats"],
  },
  {
    id: "meme-drake-yes-no",
    provider: "curated",
    type: "meme",
    title: "Drake Hotline Bling (Dislike / Like)",
    url: "https://media.giphy.com/media/3o7TKwmnDgQb5jemjK/giphy.gif",
    previewUrl: "https://media.giphy.com/media/3o7TKwmnDgQb5jemjK/giphy-preview.webp",
    width: 480,
    height: 480,
    isTransparent: false,
    tags: ["drake", "comparison", "yes", "no", "choice", "approval"],
  },
  {
    id: "meme-this-is-fine-dog",
    provider: "curated",
    type: "meme",
    title: "This is Fine Dog in Fire",
    url: "https://media.giphy.com/media/9M5jK4GXmD5o1irGrF/giphy.gif",
    previewUrl: "https://media.giphy.com/media/9M5jK4GXmD5o1irGrF/giphy-preview.webp",
    width: 480,
    height: 360,
    isTransparent: false,
    tags: ["this is fine", "fire", "dog", "crisis", "disaster", "fail", "chaos"],
  },
  {
    id: "meme-roll-safe-think-about-it",
    provider: "curated",
    type: "meme",
    title: "Roll Safe (Think About It Finger Point)",
    url: "https://media.giphy.com/media/d3mlE7uhX8KFgEmY/giphy.gif",
    previewUrl: "https://media.giphy.com/media/d3mlE7uhX8KFgEmY/giphy-preview.webp",
    width: 480,
    height: 270,
    isTransparent: false,
    tags: ["smart", "think", "brain", "idea", "tip", "hack", "advice"],
  },
  {
    id: "meme-pop-cat",
    provider: "curated",
    type: "meme",
    title: "Pop Cat Mouth Opening Rhythm",
    url: "https://media.giphy.com/media/jpbnoe3UIa8TU8LM13/giphy.gif",
    previewUrl: "https://media.giphy.com/media/jpbnoe3UIa8TU8LM13/giphy-preview.webp",
    width: 400,
    height: 400,
    isTransparent: false,
    tags: ["pop cat", "cat", "cute", "funny", "viral", "rhythm"],
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
    tags: ["arrow", "pointer", "look here", "attention", "highlight", "red"],
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
    tags: ["circle", "neon", "highlight", "focus", "glow", "marker"],
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
    tags: ["skull", "dead", "dying", "lol", "crying laughing", "rip"],
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
    tags: ["money", "cash", "dollars", "flex", "rich", "profit", "wealth"],
  },
  {
    id: "sticker-fire-flame-glow",
    provider: "curated",
    type: "sticker",
    title: "Animated Burning Fire Flame",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/nrXif9YExO9EI/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/nrXif9YExO9EI/giphy-preview.webp",
    width: 350,
    height: 350,
    isTransparent: true,
    tags: ["fire", "flame", "lit", "hot", "trending", "hype"],
  },
  {
    id: "sticker-100-percent-emoji",
    provider: "curated",
    type: "sticker",
    title: "100 Points Red Underline Emoji",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3ohzdIuqJoo8QdKlnW/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3ohzdIuqJoo8QdKlnW/giphy-preview.webp",
    width: 300,
    height: 300,
    isTransparent: true,
    tags: ["100", "score", "real", "truth", "facts", "perfect"],
  },
  {
    id: "sticker-clapping-applause",
    provider: "curated",
    type: "sticker",
    title: "Clapping Hands Applause",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/l3q2XhfQ8oCkm1GhO/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/l3q2XhfQ8oCkm1GhO/giphy-preview.webp",
    width: 350,
    height: 350,
    isTransparent: true,
    tags: ["clap", "applause", "bravo", "good job", "support", "congrats"],
  },
  {
    id: "sticker-facepalm-disappointed",
    provider: "curated",
    type: "sticker",
    title: "Cartoon Facepalm Disappointment",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/XsUmnPrd0KcAE/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/XsUmnPrd0KcAE/giphy-preview.webp",
    width: 350,
    height: 350,
    isTransparent: true,
    tags: ["facepalm", "disappointed", "smh", "mistake", "regret", "fail"],
  },
  {
    id: "sticker-deal-with-it-sunglasses",
    provider: "curated",
    type: "sticker",
    title: "Pixel Deal With It Sunglasses Drop",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/cMso9wDwqSy3e/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/cMso9wDwqSy3e/giphy-preview.webp",
    width: 350,
    height: 250,
    isTransparent: true,
    tags: ["sunglasses", "deal with it", "cool", "boss", "pixel", "thug life"],
  },
  {
    id: "sticker-warning-alert-triangle",
    provider: "curated",
    type: "sticker",
    title: "Flashing Neon Warning Sign",
    url: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3o7TKTDnUxE0gpn344/giphy.gif",
    previewUrl: "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdW5pdmVyc2Fs/3o7TKTDnUxE0gpn344/giphy-preview.webp",
    width: 350,
    height: 350,
    isTransparent: true,
    tags: ["warning", "alert", "danger", "caution", "attention", "yellow"],
  },
]);

/**
 * Sticker, Meme & Reaction GIF Overlay Service (Pillar 6 §04).
 * Connects with Giphy, Tenor, and internal Curated Meme engines to provide
 * ultra-low latency searches and sentiment-based punchline meme recommendations.
 */
@Injectable()
export class StickersService {
  private readonly logger = new Logger(StickersService.name);

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisService,
    @Optional() @Inject(RAW_STORE) private readonly rawStore?: ObjectStore,
  ) {}

  /**
   * Search across Giphy, Tenor, and the Curated Meme Catalog with Redis edge caching.
   */
  async search(queryDto: StickerSearchQueryDto): Promise<StickerSearchResponse> {
    const query = (queryDto.query ?? queryDto.q ?? "").trim();
    const type = queryDto.type ?? "all";
    const provider = queryDto.provider ?? "all";
    const limit = queryDto.limit ?? 24;
    const offset = queryDto.offset ?? 0;

    const cacheKey = `stickers:search:${provider}:${type}:${query.toLowerCase()}:${limit}:${offset}`;

    if (this.redis?.client) {
      try {
        const cached = await this.redis.client.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as StickerSearchResponse;
        }
      } catch (err) {
        this.logger.warn(`Redis get error: ${(err as Error).message}`);
      }
    }

    const aggregatedAssets: StickerItem[] = [];

    // 1. Curated library search (fast local match)
    if (provider === "all" || provider === "curated") {
      const curatedMatches = this.filterCurated(query, type);
      aggregatedAssets.push(...curatedMatches);
    }

    // 2. Query Giphy if key available
    if ((provider === "all" || provider === "giphy") && process.env.GIPHY_API_KEY) {
      try {
        const giphyResults = await this.fetchGiphySearch(query, type, limit, offset);
        aggregatedAssets.push(...giphyResults);
      } catch (err) {
        this.logger.warn(`Giphy search failed: ${(err as Error).message}`);
      }
    }

    // 3. Query Tenor if key available
    if ((provider === "all" || provider === "tenor") && process.env.TENOR_API_KEY) {
      try {
        const tenorResults = await this.fetchTenorSearch(query, type, limit, offset);
        aggregatedAssets.push(...tenorResults);
      } catch (err) {
        this.logger.warn(`Tenor search failed: ${(err as Error).message}`);
      }
    }

    // Deduplicate by ID
    const seenIds = new Set<string>();
    const uniqueAssets: StickerItem[] = [];
    for (const asset of aggregatedAssets) {
      if (!seenIds.has(asset.id)) {
        seenIds.add(asset.id);
        uniqueAssets.push(asset);
      }
    }

    const pagedAssets = uniqueAssets.slice(offset, offset + limit);
    const pageIndex = Math.floor(offset / limit) + 1;

    const response: StickerSearchResponse = {
      assets: pagedAssets,
      total: uniqueAssets.length,
      page: pageIndex,
      limit,
      categories: STICKER_CATEGORIES,
    };

    if (this.redis?.client) {
      try {
        await this.redis.client.set(
          cacheKey,
          JSON.stringify(response),
          "EX",
          REDIS_STICKER_CACHE_TTL_SEC,
        );
      } catch (err) {
        this.logger.warn(`Redis cache set error: ${(err as Error).message}`);
      }
    }

    return response;
  }

  /**
   * Get trending reaction GIFs and animated stickers.
   */
  async getTrending(queryDto: StickerTrendingQueryDto): Promise<StickerSearchResponse> {
    const type = queryDto.type ?? "all";
    const provider = queryDto.provider ?? "all";
    const limit = queryDto.limit ?? 24;

    const cacheKey = `stickers:trending:${provider}:${type}:${limit}`;

    if (this.redis?.client) {
      try {
        const cached = await this.redis.client.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as StickerSearchResponse;
        }
      } catch (err) {
        this.logger.warn(`Redis get trending error: ${(err as Error).message}`);
      }
    }

    const allFiltered = this.filterCurated("", type);
    let assets: StickerItem[];
    if (type === "all") {
      const memes = allFiltered.filter((i) => i.type === "meme");
      const stickers = allFiltered.filter((i) => i.type === "sticker");
      assets = [];
      const maxLen = Math.max(memes.length, stickers.length);
      for (let i = 0; i < maxLen && assets.length < limit; i++) {
        const memeItem = memes[i];
        if (memeItem) assets.push(memeItem);
        const stickerItem = stickers[i];
        if (stickerItem && assets.length < limit) assets.push(stickerItem);
      }
    } else {
      assets = allFiltered.slice(0, limit);
    }

    const response: StickerSearchResponse = {
      assets,
      total: assets.length,
      page: 1,
      limit,
      categories: STICKER_CATEGORIES,
    };

    if (this.redis?.client) {
      try {
        await this.redis.client.set(
          cacheKey,
          JSON.stringify(response),
          "EX",
          REDIS_STICKER_CACHE_TTL_SEC,
        );
      } catch (err) {
        this.logger.warn(`Redis cache set error: ${(err as Error).message}`);
      }
    }

    return response;
  }

  /**
   * Returns list of supported sticker & meme catalog categories.
   */
  getCategories(): readonly string[] {
    return STICKER_CATEGORIES;
  }

  /**
   * Proposes 2-3 contextual reaction memes based on transcript humor peaks or dramatic mistakes.
   */
  recommendReactionMemes(dto: StickerRecommendDto): StickerRecommendResponse {
    const text = (dto.transcript ?? "").toLowerCase();
    const explicitSentiment = (dto.sentiment ?? "").toLowerCase();
    const limit = dto.limit ?? 3;

    const recommendations: StickerRecommendation[] = [];

    // Analyze emotional tone and trigger words
    const isFunny =
      explicitSentiment.includes("funny") ||
      /\b(haha|lol|lmao|joke|hilarious|laugh|dead|funny|comedy)\b/.test(text);

    const isShocked =
      explicitSentiment.includes("shocked") ||
      /\b(shocked|crazy|unbelievable|insane|omg|no way|what the|wtf|mind blown)\b/.test(text);

    const isFail =
      explicitSentiment.includes("fail") ||
      /\b(fail|mistake|wrong|oops|terrible|bad|ruined|crying)\b/.test(text);

    const isMoney =
      explicitSentiment.includes("money") ||
      /\b(money|cash|dollars|rich|profit|wealth|crypto|expensive)\b/.test(text);

    const isAttention =
      /\b(look at this|check this out|right here|notice|important|watch this)\b/.test(text);

    const isCelebrate =
      explicitSentiment.includes("celebration") ||
      /\b(win|victory|celebrate|congrats|success|awesome|let's go)\b/.test(text);

    if (isShocked) {
      const match = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "meme-shocked-steve-harvey");
      if (match) {
        recommendations.push({
          sticker: match,
          reason: "Unbelievable moment detected in speech; punctuates listener surprise with iconic Steve Harvey stare.",
          sentiment: "shocked",
          suggestedDurationSec: 2.0,
        });
      }
      const mindBlown = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "meme-mind-blown-tim-and-eric");
      if (mindBlown) {
        recommendations.push({
          sticker: mindBlown,
          reason: "Mind-blowing insight detected; adds visual punchline to elevate audience retention.",
          sentiment: "shocked",
          suggestedDurationSec: 2.2,
        });
      }
    }

    if (isFunny) {
      const match = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "meme-michael-jordan-laughing");
      if (match) {
        recommendations.push({
          sticker: match,
          reason: "Humor peak detected in transcript; punctuates punchline with contagious Michael Jordan laugh.",
          sentiment: "funny",
          suggestedDurationSec: 2.0,
        });
      }
      const skull = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "sticker-skull-dead-reaction");
      if (skull) {
        recommendations.push({
          sticker: skull,
          reason: "I'm dead / laughing skull sticker to reinforce punchline without obscuring speaker.",
          sentiment: "funny",
          suggestedDurationSec: 1.8,
        });
      }
    }

    if (isFail) {
      const match = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "meme-pedro-pascal-laughing-crying");
      if (match) {
        recommendations.push({
          sticker: match,
          reason: "Ironic mistake or dramatic shift detected; Pedro Pascal laughing-to-crying drives comment engagement.",
          sentiment: "fail",
          suggestedDurationSec: 2.5,
        });
      }
    }

    if (isMoney) {
      const match = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "sticker-money-cash-rain");
      if (match) {
        recommendations.push({
          sticker: match,
          reason: "Financial metric or wealth topic mentioned; reinforces flex with transparent falling cash.",
          sentiment: "money",
          suggestedDurationSec: 2.0,
        });
      }
    }

    if (isAttention) {
      const match = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "sticker-animated-red-arrow");
      if (match) {
        recommendations.push({
          sticker: match,
          reason: "Speaker directs viewer gaze; animated pointer highlights key stat or graph.",
          sentiment: "attention",
          suggestedDurationSec: 1.8,
        });
      }
    }

    if (isCelebrate) {
      const match = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "meme-leonardo-dicaprio-toast");
      if (match) {
        recommendations.push({
          sticker: match,
          reason: "Winning payoff or success story; Gatsby toast provides a celebratory crescendo.",
          sentiment: "celebration",
          suggestedDurationSec: 2.2,
        });
      }
    }

    // Default fallback if no specific keywords matched
    if (recommendations.length === 0) {
      const defaultMeme = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "meme-confused-nick-young");
      const defaultArrow = CURATED_STICKERS_MEMES_LIBRARY.find((s) => s.id === "sticker-animated-red-arrow");
      if (defaultMeme) {
        recommendations.push({
          sticker: defaultMeme,
          reason: "High viral affinity reaction meme suitable for intrigue and comedic pauses.",
          sentiment: "curious",
          suggestedDurationSec: 2.0,
        });
      }
      if (defaultArrow) {
        recommendations.push({
          sticker: defaultArrow,
          reason: "Dynamic vector pointer to highlight talking-head facial expressions or captions.",
          sentiment: "attention",
          suggestedDurationSec: 1.5,
        });
      }
    }

    return {
      recommendations: recommendations.slice(0, limit),
    };
  }

  /**
   * Imports or caches a remote sticker asset to S3 for reliable offline and Remotion rendering.
   */
  async cacheStickerAsset(dto: StickerCacheDto): Promise<StickerCacheResponse> {
    const isTransparent = dto.isTransparent ?? dto.type === "sticker";
    const extension = isTransparent ? "webm" : "mp4";
    const cachedKey = `stickers/${dto.provider}/${dto.assetId}.${extension}`;

    let sizeBytes = 1024 * 1024; // default 1MB estimation

    if (this.rawStore) {
      try {
        const response = await safeFetch(dto.sourceUrl, {
          timeoutMs: PROVIDER_TIMEOUT_MS,
          maxBytes: MAX_DOWNLOAD_BYTES,
          allowedPorts: [443, 80],
        });

        if (response.status === 200 && response.body) {
          sizeBytes = response.body.byteLength;
          await this.rawStore.put({
            key: cachedKey,
            body: response.body,
            contentType: isTransparent ? "video/webm" : "video/mp4",
            tags: {
              service: "stickers-engine",
              provider: dto.provider,
            },
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to edge-cache sticker asset to S3: ${(err as Error).message}`);
      }
    }

    const cachedUrl = `https://assets.aksharo.com/${cachedKey}`;

    return {
      cachedKey,
      cachedUrl,
      isTransparent,
      format: extension,
      sizeBytes,
    };
  }

  // --- Private Helpers ---

  private filterCurated(query: string, type: StickerContentType): StickerItem[] {
    const q = query.toLowerCase();
    return CURATED_STICKERS_MEMES_LIBRARY.filter((item) => {
      if (type !== "all" && item.type !== type) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        item.title.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }

  private async fetchGiphySearch(
    query: string,
    type: StickerContentType,
    limit: number,
    offset: number,
  ): Promise<StickerItem[]> {
    const endpoint = type === "sticker" ? "stickers/search" : "gifs/search";
    const apiKey = process.env.GIPHY_API_KEY;
    const url = `https://api.giphy.com/v1/${endpoint}?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&rating=g`;

    const res = await safeFetch(url, {
      timeoutMs: PROVIDER_TIMEOUT_MS,
      allowedPorts: [443],
    });
    if (res.status !== 200) {
      throw new AppException(
        "stickers/giphy_failed",
        `Giphy API returned HTTP ${res.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const raw = JSON.parse(res.body.toString("utf8"));
    const parsed = GiphySearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return [];
    }

    return parsed.data.data.map((item) => {
      const isSticker = type === "sticker" || item.is_sticker === 1;
      const mediaUrl =
        item.images.original?.url ??
        item.images.fixed_height?.url ??
        item.images.preview_gif?.url ??
        "";
      const previewUrl =
        item.images.fixed_height_small?.webp ??
        item.images.fixed_height_small?.url ??
        item.images.preview_gif?.url ??
        mediaUrl;

      const width = parseInt(item.images.original?.width ?? "480", 10) || 480;
      const height = parseInt(item.images.original?.height ?? "480", 10) || 480;

      return {
        id: `gph-${item.id}`,
        provider: "giphy",
        type: isSticker ? "sticker" : "gif",
        title: item.title?.trim() || "Giphy Reaction Asset",
        url: mediaUrl,
        previewUrl,
        width,
        height,
        isTransparent: isSticker,
        tags: [query, "giphy", isSticker ? "sticker" : "gif"],
      };
    });
  }

  private async fetchTenorSearch(
    query: string,
    type: StickerContentType,
    limit: number,
    offset: number,
  ): Promise<StickerItem[]> {
    const apiKey = process.env.TENOR_API_KEY;
    const url = `https://tenor.googleapis.com/v2/search?key=${apiKey}&q=${encodeURIComponent(query)}&limit=${limit}&pos=${offset}`;

    const res = await safeFetch(url, {
      timeoutMs: PROVIDER_TIMEOUT_MS,
      allowedPorts: [443],
    });
    if (res.status !== 200) {
      throw new AppException(
        "stickers/tenor_failed",
        `Tenor API returned HTTP ${res.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const raw = JSON.parse(res.body.toString("utf8"));
    const parsed = TenorSearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return [];
    }

    return parsed.data.results.map((item) => {
      const mediaUrl =
        item.media_formats.webm?.url ??
        item.media_formats.mp4?.url ??
        item.media_formats.gif?.url ??
        "";
      const previewUrl =
        item.media_formats.tinygif?.url ??
        item.media_formats.gif?.url ??
        mediaUrl;

      const dims = item.media_formats.gif?.dims ?? [480, 480];

      return {
        id: `tnr-${item.id}`,
        provider: "tenor",
        type: type === "sticker" ? "sticker" : "gif",
        title: item.content_description?.trim() || item.title?.trim() || "Tenor Reaction Meme",
        url: mediaUrl,
        previewUrl,
        width: dims[0] ?? 480,
        height: dims[1] ?? 480,
        isTransparent: type === "sticker",
        tags: item.tags ?? [query, "tenor"],
      };
    });
  }
}
