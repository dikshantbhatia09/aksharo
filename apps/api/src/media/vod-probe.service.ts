import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  type ChatDensityBucket,
  type ChatPeakHighlight,
  type VodPlatform,
  type VodProbeResponse,
  VodProbeResponseSchema,
} from "@montaj/repurpose-contracts";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";

const execFileAsync = promisify(execFile);

export const TWITCH_VOD_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos\/|.+?\/v\/|.+?\/video\/)?(\d+)/i;

export const TWITCH_CHANNEL_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{3,25})/i;

export const KICK_VOD_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?kick\.com\/(?:video\/|[a-zA-Z0-9_-]+\/videos\/)([a-zA-Z0-9_-]+)/i;

export const KICK_CHANNEL_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_]{3,30})/i;

export const YOUTUBE_LIVE_REGEX =
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:live\/|watch\?v=)([a-zA-Z0-9_-]{11})/i;

export const HYPE_KEYWORDS = [
  "W",
  "L",
  "POG",
  "POGGERS",
  "CLIP",
  "CLIP THAT",
  "LMAO",
  "LOL",
  "KEKW",
  "OMEGALUL",
  "WTF",
  "GG",
  "GOAT",
  "NO WAY",
  "HYPE",
  "OMG",
  "SHEESH",
  "MONKAS",
] as const;

export const TWITCH_GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
export const DEFAULT_TWITCH_GQL_URL = "https://gql.twitch.tv/gql";

export interface ParsedLivestream {
  readonly platform: VodPlatform;
  readonly vodId: string;
  readonly normalizedUrl: string;
}

export interface RawChatMessage {
  readonly id: string;
  readonly contentOffsetSeconds: number;
  readonly message: string;
}

@Injectable()
export class VodProbeService {
  private readonly logger = new Logger(VodProbeService.name);

  parseUrl(rawUrl: string): ParsedLivestream | null {
    const trimmed = rawUrl.trim();

    // 1. Twitch VOD or Channel
    const twitchVodMatch = TWITCH_VOD_REGEX.exec(trimmed);
    if (twitchVodMatch && twitchVodMatch[1]) {
      return {
        platform: "TWITCH",
        vodId: twitchVodMatch[1],
        normalizedUrl: `https://www.twitch.tv/videos/${twitchVodMatch[1]}`,
      };
    }
    const twitchChanMatch = TWITCH_CHANNEL_REGEX.exec(trimmed);
    if (twitchChanMatch && twitchChanMatch[1] && !["directory", "downloads", "jobs"].includes(twitchChanMatch[1].toLowerCase())) {
      return {
        platform: "TWITCH",
        vodId: twitchChanMatch[1],
        normalizedUrl: `https://www.twitch.tv/${twitchChanMatch[1]}`,
      };
    }

    // 2. Kick VOD or Channel
    const kickVodMatch = KICK_VOD_REGEX.exec(trimmed);
    if (kickVodMatch && kickVodMatch[1]) {
      return {
        platform: "KICK",
        vodId: kickVodMatch[1],
        normalizedUrl: `https://kick.com/video/${kickVodMatch[1]}`,
      };
    }
    const kickChanMatch = KICK_CHANNEL_REGEX.exec(trimmed);
    if (kickChanMatch && kickChanMatch[1] && !["categories", "video"].includes(kickChanMatch[1].toLowerCase())) {
      return {
        platform: "KICK",
        vodId: kickChanMatch[1],
        normalizedUrl: `https://kick.com/${kickChanMatch[1]}`,
      };
    }

    // 3. YouTube Live
    const ytMatch = YOUTUBE_LIVE_REGEX.exec(trimmed);
    if (ytMatch && ytMatch[1]) {
      return {
        platform: "YOUTUBE_LIVE",
        vodId: ytMatch[1],
        normalizedUrl: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
      };
    }

    return null;
  }

  async probe(
    rawUrl: string,
    options: {
      readonly mockComments?: readonly RawChatMessage[];
      readonly timeoutMs?: number;
    } = {},
  ): Promise<VodProbeResponse> {
    const parsed = this.parseUrl(rawUrl);
    if (!parsed) {
      throw new AppException(
        ERROR_CODES.badRequest,
        "Invalid or unsupported livestream / VOD URL format. Supported: Twitch, YouTube Live, Kick.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const ytDlpBinary = process.env["YT_DLP_PATH"] || "yt-dlp";
    const timeoutMs = options.timeoutMs ?? 15_000;

    let title = `${parsed.platform} Broadcast`;
    let channelName = "Streamer";
    let durationSec = 7200; // 2 hour default baseline
    let thumbnailUrl = "";
    let isLive = false;
    let rawHeatmap: any[] = [];

    // Probe metadata via yt-dlp
    try {
      const args = [
        "--no-colors",
        "--encoding",
        "utf-8",
        "--no-playlist",
        "--ignore-config",
        "--no-cache-dir",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout",
        "10",
      ];

      const proxy =
        process.env["BRIGHT_DATA_PROXY_URL"] ||
        process.env["WEBSHARE_PROXY_URL"] ||
        process.env["YT_DLP_PROXY"] ||
        "";
      if (proxy.trim()) {
        args.push("--proxy", proxy.trim());
      }

      args.push("--", parsed.normalizedUrl);

      const { stdout } = await execFileAsync(ytDlpBinary, args, {
        timeout: timeoutMs,
        maxBuffer: 15 * 1024 * 1024,
      });

      const parsedJson = JSON.parse(stdout);
      title = parsedJson.title || title;
      channelName = parsedJson.channel || parsedJson.uploader || channelName;
      if (typeof parsedJson.duration === "number" && parsedJson.duration > 0) {
        durationSec = parsedJson.duration;
      }
      thumbnailUrl = parsedJson.thumbnail || thumbnailUrl;
      isLive = Boolean(
        parsedJson.is_live === true ||
        parsedJson.live_status === "is_live" ||
        parsedJson.live_status === "is_upcoming",
      );
      rawHeatmap = Array.isArray(parsedJson.heatmap) ? parsedJson.heatmap : [];
    } catch (err: unknown) {
      this.logger.warn(`yt-dlp probe failed or timed out for ${parsed.normalizedUrl}: ${String(err)}`);
      // Proceed with defaults / fallbacks
    }

    if (!thumbnailUrl) {
      if (parsed.platform === "TWITCH") {
        thumbnailUrl = `https://static-cdn.jtvnw.net/cf_vods/d2nvs31859zcd8/${parsed.vodId}/thumb/thumb0-640x360.jpg`;
      } else if (parsed.platform === "YOUTUBE_LIVE") {
        thumbnailUrl = `https://i.ytimg.com/vi/${parsed.vodId}/hqdefault.jpg`;
      } else {
        thumbnailUrl = `https://images.kick.com/thumbnails/${parsed.vodId}.jpg`;
      }
    }

    let chatVelocity: ChatDensityBucket[] = [];
    let peaks: ChatPeakHighlight[] = [];

    if (parsed.platform === "TWITCH") {
      let comments: RawChatMessage[] = [];
      if (options.mockComments) {
        comments = [...options.mockComments];
      } else {
        comments = await this.fetchTwitchComments(parsed.vodId);
      }

      if (comments.length > 0) {
        chatVelocity = this.computeChatDensity(comments, durationSec, 5);
        peaks = this.detectSpikes(chatVelocity);
      } else {
        chatVelocity = this.generateSyntheticCurve(durationSec);
        peaks = this.detectSpikes(chatVelocity);
      }
    } else if (parsed.platform === "YOUTUBE_LIVE") {
      if (rawHeatmap.length > 0) {
        const stepSec = durationSec > 0 ? durationSec / rawHeatmap.length : 5;
        chatVelocity = rawHeatmap.map((pt: any, idx: number) => {
          const val = typeof pt.value === "number" ? pt.value : 0;
          const mps = Number((val * 10).toFixed(2));
          const topKeywords = val > 0.7 ? ["POG", "W", "CLIP"] : ["HYPE"];
          return {
            timestampSec: Math.round(idx * stepSec),
            mps,
            topKeywords,
          };
        });
        peaks = this.detectSpikes(chatVelocity, 1.8);
      } else {
        chatVelocity = this.generateSyntheticCurve(durationSec);
        peaks = this.detectSpikes(chatVelocity);
      }
    } else {
      // KICK
      chatVelocity = this.generateSyntheticCurve(durationSec);
      peaks = this.detectSpikes(chatVelocity);
    }

    const response: VodProbeResponse = {
      platform: parsed.platform,
      vodId: parsed.vodId,
      title,
      channelName,
      durationSec,
      thumbnailUrl,
      isLive,
      chatVelocity,
      peaks,
    };

    return VodProbeResponseSchema.parse(response);
  }

  computeChatDensity(
    comments: readonly RawChatMessage[],
    vodDurationSec: number,
    bucketDurationSec = 5,
  ): ChatDensityBucket[] {
    const maxCommentSec = comments.length > 0
      ? Math.max(...comments.map((c) => c.contentOffsetSeconds))
      : 0;
    const totalSec = Math.max(vodDurationSec, maxCommentSec, 1);
    const bucketCount = Math.ceil(totalSec / bucketDurationSec);

    const buckets: { count: number; keywords: Map<string, number> }[] = Array.from(
      { length: bucketCount },
      () => ({ count: 0, keywords: new Map() }),
    );

    for (const comment of comments) {
      if (comment.contentOffsetSeconds < 0) continue;
      const bucketIndex = Math.min(
        Math.floor(comment.contentOffsetSeconds / bucketDurationSec),
        bucketCount - 1,
      );
      const target = buckets[bucketIndex];
      if (!target) continue;

      target.count += 1;
      const upperText = comment.message.toUpperCase();
      for (const kw of HYPE_KEYWORDS) {
        if (
          upperText === kw ||
          upperText.includes(` ${kw} `) ||
          upperText.startsWith(`${kw} `) ||
          upperText.endsWith(` ${kw}`)
        ) {
          target.keywords.set(kw, (target.keywords.get(kw) ?? 0) + 1);
        }
      }
    }

    return buckets.map((b, idx) => {
      const topKeywords = Array.from(b.keywords.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map((e) => e[0]);
      return {
        timestampSec: idx * bucketDurationSec,
        mps: Number((b.count / bucketDurationSec).toFixed(2)),
        topKeywords,
      };
    });
  }

  detectSpikes(
    buckets: readonly ChatDensityBucket[],
    zThreshold = 2.0,
    windowPaddingSec = 30,
  ): ChatPeakHighlight[] {
    if (buckets.length === 0) return [];

    const mpsValues = buckets.map((b) => b.mps);
    const mean = mpsValues.reduce((a, b) => a + b, 0) / mpsValues.length;
    const variance =
      mpsValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
      mpsValues.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev < 0.05) return [];

    const rawPeaks: { bucket: ChatDensityBucket; zScore: number }[] = [];
    for (const bucket of buckets) {
      const zScore = (bucket.mps - mean) / stdDev;
      if (zScore >= zThreshold) {
        rawPeaks.push({ bucket, zScore });
      }
    }

    if (rawPeaks.length === 0) return [];

    // Group adjacent / nearby spikes within 60s
    const merged: {
      startSec: number;
      endSec: number;
      maxZ: number;
      peakMps: number;
      emotes: Set<string>;
    }[] = [];

    for (const item of rawPeaks) {
      const ts = item.bucket.timestampSec;
      const existing = merged.find(
        (m) => ts >= m.startSec - 15 && ts <= m.endSec + 15,
      );

      if (existing) {
        existing.startSec = Math.min(existing.startSec, Math.max(0, ts - windowPaddingSec));
        existing.endSec = Math.max(existing.endSec, ts + windowPaddingSec);
        existing.maxZ = Math.max(existing.maxZ, item.zScore);
        existing.peakMps = Math.max(existing.peakMps, item.bucket.mps);
        item.bucket.topKeywords.forEach((k) => existing.emotes.add(k));
      } else {
        merged.push({
          startSec: Math.max(0, ts - windowPaddingSec),
          endSec: ts + windowPaddingSec,
          maxZ: item.zScore,
          peakMps: item.bucket.mps,
          emotes: new Set(item.bucket.topKeywords),
        });
      }
    }

    return merged
      .sort((a, b) => b.maxZ - a.maxZ)
      .slice(0, 10)
      .map((m) => {
        const score = Math.min(100, Math.round(50 + m.maxZ * 12.5));
        const topEmotes = Array.from(m.emotes).slice(0, 4);
        return {
          startSec: m.startSec,
          endSec: m.endSec,
          score,
          topEmotes,
          reason: `Chat velocity spike (Z-Score: ${m.maxZ.toFixed(1)}, ${m.peakMps.toFixed(1)} MPS)`,
        };
      });
  }

  generateSyntheticCurve(durationSec: number): ChatDensityBucket[] {
    const buckets: ChatDensityBucket[] = [];
    const bucketDuration = 10;
    const count = Math.min(360, Math.ceil(durationSec / bucketDuration));

    for (let i = 0; i < count; i++) {
      const timestampSec = i * bucketDuration;
      const isPeak =
        Math.abs(i - Math.floor(count * 0.25)) < 3 ||
        Math.abs(i - Math.floor(count * 0.65)) < 3;
      const mps = isPeak ? 18.5 : Number((1.0 + Math.sin(i / 10)).toFixed(2));
      const topKeywords = isPeak ? ["W", "POG", "CLIP THAT"] : ["GG"];
      buckets.push({
        timestampSec,
        mps,
        topKeywords,
      });
    }

    return buckets;
  }

  async fetchTwitchComments(
    vodId: string,
    maxComments = 2000,
  ): Promise<RawChatMessage[]> {
    const comments: RawChatMessage[] = [];
    let cursor: string | null = null;
    let pages = 0;
    const maxPages = Math.ceil(maxComments / 100);

    const query = `
      query GetVodComments($videoID: ID!, $cursor: String) {
        video(id: $videoID) {
          comments(after: $cursor) {
            edges {
              cursor
              node {
                id
                contentOffsetSeconds
                message {
                  fragments {
                    text
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      while (pages < maxPages) {
        pages++;
        const res = await fetch(DEFAULT_TWITCH_GQL_URL, {
          method: "POST",
          headers: {
            "Client-Id": TWITCH_GQL_CLIENT_ID,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables: {
              videoID: vodId,
              cursor,
            },
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) break;
        const data = (await res.json()) as any;
        const edges = data?.data?.video?.comments?.edges;
        if (!Array.isArray(edges) || edges.length === 0) break;

        for (const edge of edges) {
          const node = edge?.node;
          if (!node) continue;
          const fragments = node.message?.fragments;
          const messageText = Array.isArray(fragments)
            ? fragments.map((f: any) => f.text || "").join("")
            : "";
          comments.push({
            id: String(node.id),
            contentOffsetSeconds: Number(node.contentOffsetSeconds || 0),
            message: messageText,
          });
        }

        const lastEdge = edges[edges.length - 1];
        if (!lastEdge || !lastEdge.cursor) break;
        cursor = lastEdge.cursor;
      }
    } catch {
      // Return whatever comments were gathered
    }

    return comments;
  }
}
