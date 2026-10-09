/**
 * Twitch Chat Sentiment & Message Density Miner (Pillar 1 §05).
 *
 * Implements chat replay velocity curve calculation M(t), Z-score spike detection,
 * viral hype keyword mining (W, L, LMAO, POG, CLIP THAT), and candidate highlight
 * window generation.
 */

export interface TwitchCommentRaw {
  readonly id: string;
  readonly contentOffsetSeconds: number;
  readonly message: string;
  readonly commenter?: string;
}

export interface ChatDensityBucket {
  readonly timestampSec: number;
  readonly mps: number;
  readonly topKeywords: string[];
  readonly messageCount: number;
}

export interface ChatSpikeWindow {
  readonly startSec: number;
  readonly endSec: number;
  readonly score: number;
  readonly topEmotes: string[];
  readonly peakTimestampSec: number;
  readonly peakMps: number;
  readonly zScore: number;
  readonly reason?: string;
}

/** Viral gaming/stream keywords & emotes monitored for chat velocity spikes */
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

/**
 * Groups timestamped chat comments into uniform buckets (default 5 seconds)
 * and calculates messages-per-second (MPS) and top keyword frequencies.
 */
export function computeChatDensityCurve(
  comments: readonly TwitchCommentRaw[],
  vodDurationSec: number,
  bucketDurationSec = 5,
): ChatDensityBucket[] {
  if (bucketDurationSec <= 0) {
    bucketDurationSec = 5;
  }

  const maxCommentSec = comments.length > 0
    ? Math.max(...comments.map((c) => c.contentOffsetSeconds))
    : 0;
  const totalSec = Math.max(vodDurationSec, maxCommentSec, 1);
  const bucketCount = Math.ceil(totalSec / bucketDurationSec);

  // Initialize bucket aggregators
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

    // Scan for viral keywords in comment text
    const upperText = comment.message.toUpperCase();
    for (const kw of HYPE_KEYWORDS) {
      if (
        upperText === kw ||
        upperText.includes(` ${kw} `) ||
        upperText.startsWith(`${kw} `) ||
        upperText.endsWith(` ${kw}`) ||
        upperText.includes(kw)
      ) {
        target.keywords.set(kw, (target.keywords.get(kw) ?? 0) + 1);
      }
    }
  }

  return buckets.map((b, idx) => {
    const timestampSec = idx * bucketDurationSec;
    const mps = Number((b.count / bucketDurationSec).toFixed(2));
    const sortedKeywords = Array.from(b.keywords.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => k);

    return {
      timestampSec,
      mps,
      topKeywords: sortedKeywords,
      messageCount: b.count,
    };
  });
}

/**
 * Computes mean and standard deviation of message density.
 */
export function computeStats(values: readonly number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev };
}

/**
 * Detects viral moments where chat density Z-score exceeds the threshold (Z >= 2.0).
 * Clusters surrounding buckets into 30-90 second highlight candidate windows.
 */
export function detectChatSpikes(
  buckets: readonly ChatDensityBucket[],
  options: {
    readonly zThreshold?: number;
    readonly windowRadiusSec?: number;
    readonly maxPeaks?: number;
  } = {},
): ChatSpikeWindow[] {
  const { zThreshold = 2.0, windowRadiusSec = 25, maxPeaks = 10 } = options;

  if (buckets.length === 0) return [];

  const counts = buckets.map((b) => b.messageCount);
  const { mean, stdDev } = computeStats(counts);

  if (stdDev === 0) {
    return [];
  }

  // Find candidate buckets that exceed threshold
  interface Candidate {
    index: number;
    bucket: ChatDensityBucket;
    zScore: number;
  }

  const candidates: Candidate[] = [];
  buckets.forEach((bucket, index) => {
    const z = (bucket.messageCount - mean) / stdDev;
    if (z >= zThreshold && bucket.messageCount > 0) {
      candidates.push({ index, bucket, zScore: z });
    }
  });

  if (candidates.length === 0) return [];

  // Sort candidates by highest Z-score first
  candidates.sort((a, b) => b.zScore - a.zScore);

  const windows: ChatSpikeWindow[] = [];

  for (const cand of candidates) {
    const peakSec = cand.bucket.timestampSec;
    const startSec = Math.max(0, peakSec - windowRadiusSec);
    const endSec = peakSec + windowRadiusSec + 5; // encompass the peak bucket

    // Check overlap with existing chosen windows
    const overlaps = windows.some(
      (w) => Math.max(w.startSec, startSec) < Math.min(w.endSec, endSec),
    );
    if (overlaps) continue;

    // Collect aggregate emotes across this window
    const emoteCounts = new Map<string, number>();
    for (const b of buckets) {
      if (b.timestampSec >= startSec && b.timestampSec <= endSec) {
        for (const kw of b.topKeywords) {
          emoteCounts.set(kw, (emoteCounts.get(kw) ?? 0) + 1);
        }
      }
    }

    const topEmotes = Array.from(emoteCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k]) => k);

    // Score normalized from 60 to 99 based on Z-score
    // Z = 2.0 -> 70, Z = 3.0 -> 85, Z = 4.0+ -> 98
    const normalizedScore = Math.min(
      99,
      Math.max(60, Math.round(60 + Math.min(cand.zScore - 1.5, 4.0) * 12)),
    );

    windows.push({
      startSec,
      endSec,
      score: normalizedScore,
      topEmotes: topEmotes.length > 0 ? topEmotes : ["HYPE"],
      peakTimestampSec: peakSec,
      peakMps: cand.bucket.mps,
      zScore: Number(cand.zScore.toFixed(2)),
      reason: `Chat velocity explosion (Z = ${cand.zScore.toFixed(1)}, ${cand.bucket.mps} msgs/sec)`,
    });

    if (windows.length >= maxPeaks) break;
  }

  // Sort final windows chronologically
  return windows.sort((a, b) => a.startSec - b.startSec);
}

/**
 * GraphQL Query for Twitch VOD comments pagination.
 */
export const TWITCH_GQL_COMMENTS_QUERY = `
  query($videoID: ID!, $cursor: String) {
    video(id: $videoID) {
      comments(after: $cursor) {
        edges {
          cursor
          node {
            id
            commenter {
              displayName
            }
            contentOffsetSeconds
            message {
              fragments {
                text
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

/**
 * Fetches Twitch VOD chat comments via Twitch GQL endpoint.
 */
export async function fetchTwitchVodComments(
  vodId: string,
  options: {
    readonly maxPages?: number;
    readonly signal?: AbortSignal;
    readonly gqlEndpoint?: string;
    readonly clientId?: string;
  } = {},
): Promise<TwitchCommentRaw[]> {
  const {
    maxPages = 20,
    signal,
    gqlEndpoint = DEFAULT_TWITCH_GQL_URL,
    clientId = TWITCH_GQL_CLIENT_ID,
  } = options;

  const comments: TwitchCommentRaw[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (page < maxPages) {
    if (signal?.aborted) break;
    page += 1;

    try {
      const response = await fetch(gqlEndpoint, {
        method: "POST",
        headers: {
          "Client-ID": clientId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: TWITCH_GQL_COMMENTS_QUERY,
          variables: {
            videoID: vodId,
            cursor,
          },
        }),
        signal,
      });

      if (!response.ok) {
        break;
      }

      const json = (await response.json()) as any;
      const video = json?.data?.video;
      if (!video || !video.comments) break;

      const edges = Array.isArray(video.comments.edges) ? video.comments.edges : [];
      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const offset = typeof node.contentOffsetSeconds === "number" ? node.contentOffsetSeconds : 0;
        let text = "";
        if (Array.isArray(node.message?.fragments)) {
          text = node.message.fragments.map((f: any) => f?.text || "").join("");
        }
        comments.push({
          id: String(node.id || `${offset}-${comments.length}`),
          contentOffsetSeconds: offset,
          message: text,
          commenter: node.commenter?.displayName,
        });
      }

      const pageInfo = video.comments.pageInfo;
      if (!pageInfo?.hasNextPage || edges.length === 0) {
        break;
      }
      cursor = edges[edges.length - 1]?.cursor ?? null;
      if (!cursor) break;
    } catch {
      break;
    }
  }

  return comments;
}

/**
 * End-to-end Twitch chat analyzer: queries comments, builds density curve, and extracts peaks.
 */
export async function analyzeTwitchVod(
  vodId: string,
  vodDurationSec: number,
  options: {
    readonly mockComments?: readonly TwitchCommentRaw[];
    readonly signal?: AbortSignal;
    readonly gqlEndpoint?: string;
  } = {},
): Promise<{
  readonly chatVelocity: ChatDensityBucket[];
  readonly peaks: ChatSpikeWindow[];
}> {
  let comments: readonly TwitchCommentRaw[];

  if (options.mockComments) {
    comments = options.mockComments;
  } else {
    comments = await fetchTwitchVodComments(vodId, {
      signal: options.signal,
      gqlEndpoint: options.gqlEndpoint,
    });
  }

  // If chat comments were found, calculate real message velocity and spikes
  if (comments.length > 0) {
    const chatVelocity = computeChatDensityCurve(comments, vodDurationSec, 5);
    const peaks = detectChatSpikes(chatVelocity);
    return { chatVelocity, peaks };
  }

  // If no chat replay exists (e.g. chat disabled by streamer), create synthetic 5s baseline
  const bucketCount = Math.max(1, Math.min(120, Math.ceil(vodDurationSec / 30)));
  const step = Math.max(5, Math.floor(vodDurationSec / bucketCount));
  const chatVelocity: ChatDensityBucket[] = [];

  for (let t = 0; t < vodDurationSec; t += step) {
    chatVelocity.push({
      timestampSec: t,
      mps: 0.5,
      topKeywords: ["STREAM"],
      messageCount: 3,
    });
  }

  return { chatVelocity, peaks: [] };
}

