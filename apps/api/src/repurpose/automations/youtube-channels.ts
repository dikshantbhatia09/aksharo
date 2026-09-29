import { parseChannelFeed } from "./channel-feed.js";
import { channelFromPage } from "./channel-page.js";
import { CHANNEL_ID } from "./channel-url.js";
import { XmlParseError } from "./safe-xml.js";
import { FEED_MAX_BYTES, PAGE_MAX_BYTES, YouTubeHttpError, isBlockPage } from "./youtube-http.js";

import type { ChannelFeed } from "./channel-feed.js";
import type { ParsedChannelUrl } from "./channel-url.js";
import type { YouTubeHttp, YouTubeResponse } from "./youtube-http.js";
import type { SourceGateState } from "../source-gate.js";

/**
 * Channels, as automations need them (2026-10-02): a pasted link resolved to
 * the channel's id and name, and a channel's latest uploads.
 *
 * **The gate first, always.** `SourceGate` is the circuit breaker every YouTube
 * download already obeys. Nothing here is fetched unless the gate is fully
 * closed: while it is open, and while it is half-open - when one download is
 * meant to go first and find out whether YouTube is answering again - a lookup
 * fails as `busy` without a request. A 429, or Google's "unusual traffic" page,
 * trips the gate for everyone: a refusal of a feed read is a refusal of this
 * IP, and the downloads behind it would only make it longer.
 *
 * **Cached.** A resolved link is remembered for an hour and a channel that does
 * not exist for ten minutes, per process, so previewing the same link while
 * filling in the form costs one request.
 */

export type ChannelLookupErrorCode = "not_found" | "busy" | "unreadable" | "unavailable";

export class ChannelLookupError extends Error {
  constructor(
    readonly code: ChannelLookupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelLookupError";
  }
}

export interface ResolvedChannel {
  readonly channelId: string;
  readonly title: string;
  /** The handle it was found by, when it was one. */
  readonly handle: string | null;
}

/** What the rest of the module asks of YouTube. The seam tests replace. */
export interface ChannelDirectory {
  /** @throws ChannelLookupError */
  resolve(channel: ParsedChannelUrl): Promise<ResolvedChannel>;
  /** The channel's latest uploads, newest first. @throws ChannelLookupError */
  uploads(channelId: string): Promise<ChannelFeed>;
}

/** The injection token for {@link ChannelDirectory}. */
export const CHANNEL_DIRECTORY = Symbol("CHANNEL_DIRECTORY");

/** What of `SourceGate` the directory uses. */
export interface YouTubeGate {
  state(now?: number): Promise<SourceGateState>;
  trip(now?: number): Promise<number>;
}

export const RESOLVED_TTL_MS = 60 * 60_000;
export const NOT_FOUND_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;

type Cached =
  | { readonly until: number; readonly channel: ResolvedChannel }
  | { readonly until: number; readonly channel: null };

export class YouTubeChannelDirectory implements ChannelDirectory {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly http: YouTubeHttp,
    /** Null only where there is no Redis at all (a unit harness): then nothing gates. */
    private readonly gate: YouTubeGate | null,
    private readonly clock: () => number = Date.now,
  ) {}

  async resolve(channel: ParsedChannelUrl): Promise<ResolvedChannel> {
    const now = this.clock();
    const cached = this.cache.get(channel.key);
    if (cached !== undefined && cached.until > now) {
      if (cached.channel === null) throw notFound();
      return cached.channel;
    }

    try {
      const resolved = await this.lookUp(channel);
      this.remember(channel.key, { until: now + RESOLVED_TTL_MS, channel: resolved });
      return resolved;
    } catch (error) {
      if (error instanceof ChannelLookupError && error.code === "not_found") {
        this.remember(channel.key, { until: now + NOT_FOUND_TTL_MS, channel: null });
      }
      throw error;
    }
  }

  async uploads(channelId: string): Promise<ChannelFeed> {
    if (!CHANNEL_ID.test(channelId)) throw new ChannelLookupError("unreadable", "not a channel id");
    const response = await this.fetch(`/feeds/videos.xml?channel_id=${channelId}`, FEED_MAX_BYTES);
    if (response.status === 404) throw notFound();
    if (response.status !== 200) {
      throw new ChannelLookupError("unavailable", `the feed answered ${String(response.status)}`);
    }
    let feed: ChannelFeed;
    try {
      feed = parseChannelFeed(response.body.toString("utf8"));
    } catch (error) {
      if (error instanceof XmlParseError) {
        throw new ChannelLookupError("unreadable", `the feed could not be read (${error.code})`);
      }
      throw error;
    }
    // A feed about another channel is not this channel's feed.
    if (feed.channelId !== null && feed.channelId !== channelId) {
      throw new ChannelLookupError("unreadable", "the feed is about another channel");
    }
    return feed;
  }

  private async lookUp(channel: ParsedChannelUrl): Promise<ResolvedChannel> {
    const { ref } = channel;
    if (ref.kind === "id") {
      // The feed says the name, and whether the channel exists, in one small read.
      const feed = await this.uploads(ref.channelId);
      return { channelId: ref.channelId, title: feed.title ?? ref.channelId, handle: null };
    }
    if (channel.pagePath === null) throw new ChannelLookupError("unreadable", "nothing to read");
    const response = await this.fetch(channel.pagePath, PAGE_MAX_BYTES);
    if (response.status === 404) throw notFound();
    if (response.status !== 200) {
      throw new ChannelLookupError("unavailable", `the page answered ${String(response.status)}`);
    }
    const page = channelFromPage(response.body.toString("utf8"));
    if (page === null) {
      throw new ChannelLookupError("unreadable", "the page does not say which channel it is");
    }
    const fallback = ref.kind === "handle" ? `@${ref.handle}` : ref.name;
    return {
      channelId: page.channelId,
      title: page.title ?? fallback,
      handle: ref.kind === "handle" ? ref.handle : null,
    };
  }

  /** One request, if the gate allows it; a refusal trips the gate. */
  private async fetch(path: string, maxBytes: number): Promise<YouTubeResponse> {
    if (this.gate !== null) {
      const state = await this.gate.state(this.clock());
      if (state.openUntil !== null || state.trips > 0) {
        throw new ChannelLookupError("busy", "YouTube is refusing this server for now");
      }
    }
    let response: YouTubeResponse;
    try {
      response = await this.http.get(path, maxBytes);
    } catch (error) {
      if (error instanceof YouTubeHttpError && isBlockPage(error.location)) {
        await this.gate?.trip(this.clock());
        throw new ChannelLookupError("busy", "YouTube sent its unusual-traffic page");
      }
      const code = error instanceof YouTubeHttpError ? error.code : "network";
      throw new ChannelLookupError("unavailable", `YouTube could not be read (${code})`);
    }
    if (response.status === 429) {
      await this.gate?.trip(this.clock());
      throw new ChannelLookupError("busy", "YouTube answered 429");
    }
    return response;
  }

  private remember(key: string, entry: Cached): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next();
      if (oldest.done !== true) this.cache.delete(oldest.value);
    }
  }
}

function notFound(): ChannelLookupError {
  return new ChannelLookupError("not_found", "no such channel");
}
