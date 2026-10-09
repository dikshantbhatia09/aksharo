/**
 * SponsorBlock API Client with Redis Caching (Pillar 2 §04).
 *
 * Cross-references crowd-verified sponsor cut points from SponsorBlock (https://sponsor.ajay.app)
 * for YouTube source inputs. Segments include sponsored segments, affiliate pitches, channel
 * intros, and outro subscribe calls-to-action.
 */

import { logger } from "../logger.js";

export const SPONSORBLOCK_API_URL = "https://sponsor.ajay.app/api/skipSegments";
export const SPONSORBLOCK_CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days in seconds

export const DEFAULT_SPONSOR_CATEGORIES = [
  "sponsor",
  "selfpromo",
  "intro",
  "outro",
] as const;

export type SponsorBlockCategory =
  | "sponsor"
  | "selfpromo"
  | "intro"
  | "outro"
  | "interaction"
  | "preview"
  | "music_offtopic";

export interface SponsorBlockRawSegment {
  readonly category: string;
  readonly segment: readonly [number, number];
  readonly UUID?: string;
  readonly actionType?: string;
  readonly locked?: number;
  readonly votes?: number;
}

export interface SponsorBlockSegment {
  readonly category: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly actionType: string;
  readonly uuid?: string;
  readonly votes?: number;
}

export interface SponsorBlockRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<unknown>;
}

export interface SponsorBlockOptions {
  readonly redis?: SponsorBlockRedisClient | null;
  readonly fetchFn?: typeof fetch;
  readonly categories?: readonly string[];
  readonly timeoutMs?: number;
  readonly apiUrl?: string;
  readonly signal?: AbortSignal;
}

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_URL_REGEX =
  /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|live|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;

/**
 * Extracts standard 11-character YouTube video ID from a URL or raw ID string.
 */
export function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (YOUTUBE_ID_REGEX.test(trimmed)) {
    return trimmed;
  }
  const match = YOUTUBE_URL_REGEX.exec(trimmed);
  return match && match[1] ? match[1] : null;
}

/**
 * Checks whether an input string represents a YouTube URL or video ID.
 */
export function isYouTubeSource(input: string): boolean {
  return extractYouTubeVideoId(input) !== null;
}

/**
 * Queries the public SponsorBlock API for known sponsor and promo segments.
 * Caches responses in Redis with a 7-day TTL.
 */
export async function fetchSponsorSegments(
  videoIdOrUrl: string,
  options: SponsorBlockOptions = {},
): Promise<readonly SponsorBlockSegment[]> {
  const videoId = extractYouTubeVideoId(videoIdOrUrl);
  if (!videoId) {
    return [];
  }

  const redis = options.redis ?? null;
  const cacheKey = `sponsorblock:${videoId}`;

  // 1. Check Redis cache first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (cacheErr) {
      logger.warn("Failed to read SponsorBlock segments from Redis cache", {
        videoId,
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }
  }

  // 2. Query SponsorBlock API
  const fetchFn = options.fetchFn ?? fetch;
  const apiUrl = options.apiUrl ?? SPONSORBLOCK_API_URL;
  const categories = options.categories ?? DEFAULT_SPONSOR_CATEGORIES;
  const timeoutMs = options.timeoutMs ?? 4000;

  const url = new URL(apiUrl);
  url.searchParams.set("videoID", videoId);
  url.searchParams.set("categories", JSON.stringify(categories));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchFn(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: options.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // SponsorBlock returns 404 when no skip segments have been submitted for the video
    if (res.status === 404) {
      const emptyResult: readonly SponsorBlockSegment[] = [];
      if (redis) {
        try {
          // Cache negative result for 24 hours to prevent repeated 404 hits
          await redis.set(cacheKey, JSON.stringify(emptyResult), "EX", 24 * 60 * 60);
        } catch {
          // Ignore cache write error
        }
      }
      return emptyResult;
    }

    if (!res.ok) {
      logger.warn("SponsorBlock API returned non-OK response", {
        status: res.status,
        videoId,
      });
      return [];
    }

    const rawData = (await res.json()) as readonly SponsorBlockRawSegment[];
    if (!Array.isArray(rawData)) {
      return [];
    }

    const segments: SponsorBlockSegment[] = rawData
      .filter((item) => Array.isArray(item.segment) && item.segment.length >= 2)
      .map((item) => {
        const startSec = Math.max(0, item.segment[0]);
        const endSec = Math.max(startSec, item.segment[1]);
        return {
          category: item.category || "sponsor",
          startSec,
          endSec,
          startMs: Math.round(startSec * 1000),
          endMs: Math.round(endSec * 1000),
          actionType: item.actionType || "skip",
          uuid: item.UUID,
          votes: item.votes,
        };
      })
      .filter((s) => s.endMs > s.startMs);

    // 3. Cache valid result in Redis with 7-day TTL
    if (redis) {
      try {
        await redis.set(
          cacheKey,
          JSON.stringify(segments),
          "EX",
          SPONSORBLOCK_CACHE_TTL_SEC,
        );
      } catch (cacheErr) {
        logger.warn("Failed to cache SponsorBlock segments in Redis", {
          videoId,
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }
    }

    return segments;
  } catch (err) {
    logger.warn("Failed to fetch segments from SponsorBlock API", {
      videoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Converts SponsorBlock segments to exclude intervals formatted for clipping engines.
 */
export function sponsorSegmentsToExcludeRanges(
  segments: readonly SponsorBlockSegment[],
): ReadonlyArray<{ readonly startMs: number; readonly endMs: number }> {
  return segments.map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
  }));
}
