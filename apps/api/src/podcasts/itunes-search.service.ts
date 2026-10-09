import { Injectable, Logger } from "@nestjs/common";

export interface PodcastSearchResult {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly feedUrl: string;
  readonly artworkUrl?: string;
  readonly episodeCount?: number;
  readonly genres?: readonly string[];
}

/**
 * Service to discover podcasts via the Apple Podcasts (iTunes) Search & Lookup API.
 * Allows creators to find their show by name without having to manually find their raw RSS URL.
 */
@Injectable()
export class ItunesSearchService {
  private readonly logger = new Logger(ItunesSearchService.name);

  /**
   * Search podcasts by title, host, or keyword.
   * If query is an Apple Podcasts URL, looks up the specific show directly.
   */
  async search(
    query: string,
    limit: number = 10,
    customFetch: typeof fetch = fetch,
  ): Promise<PodcastSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Check if query is an Apple Podcasts URL: e.g. https://podcasts.apple.com/.../id1200361736
    const appleMatch = trimmed.match(/\/id(\d{6,12})/i);
    if (appleMatch && appleMatch[1]) {
      const showId = appleMatch[1];
      const lookupResult = await this.lookupById(showId, customFetch);
      if (lookupResult) return [lookupResult];
    }

    const apiUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(trimmed)}&entity=podcast&limit=${Math.min(limit, 25)}`;

    try {
      const response = await customFetch(apiUrl, {
        headers: {
          "User-Agent": "Aksharo-Podcast-Engine/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) {
        this.logger.warn(`iTunes search failed with status ${response.status} for query "${query}"`);
        return [];
      }

      const data = (await response.json()) as any;
      const rawResults: any[] = Array.isArray(data?.results) ? data.results : [];

      return rawResults
        .filter((item) => typeof item.feedUrl === "string" && item.feedUrl.startsWith("http"))
        .map((item) => ({
          id: String(item.collectionId || item.trackId || item.feedUrl),
          title: item.collectionName || item.trackName || "Untitled Podcast",
          author: item.artistName || undefined,
          feedUrl: item.feedUrl,
          artworkUrl: item.artworkUrl600 || item.artworkUrl100 || item.artworkUrl60 || undefined,
          episodeCount: typeof item.trackCount === "number" ? item.trackCount : undefined,
          genres: Array.isArray(item.genres) ? item.genres : undefined,
        }));
    } catch (err: any) {
      this.logger.error(`Error querying iTunes search API: ${err?.message}`);
      return [];
    }
  }

  /**
   * Lookup a specific podcast by its iTunes numeric Collection ID.
   */
  async lookupById(
    collectionId: string,
    customFetch: typeof fetch = fetch,
  ): Promise<PodcastSearchResult | null> {
    const apiUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}&entity=podcast`;

    try {
      const response = await customFetch(apiUrl, {
        headers: {
          "User-Agent": "Aksharo-Podcast-Engine/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as any;
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      const item = results.find((r) => r.wrapperType === "track" || r.kind === "podcast" || r.feedUrl);

      if (!item || !item.feedUrl) return null;

      return {
        id: String(item.collectionId || item.trackId || collectionId),
        title: item.collectionName || item.trackName || "Untitled Podcast",
        author: item.artistName || undefined,
        feedUrl: item.feedUrl,
        artworkUrl: item.artworkUrl600 || item.artworkUrl100 || undefined,
        episodeCount: typeof item.trackCount === "number" ? item.trackCount : undefined,
        genres: Array.isArray(item.genres) ? item.genres : undefined,
      };
    } catch (err: any) {
      this.logger.error(`Error looking up podcast ID ${collectionId}: ${err?.message}`);
      return null;
    }
  }
}

