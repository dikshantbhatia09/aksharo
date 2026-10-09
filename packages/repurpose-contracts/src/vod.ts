import { z } from "zod";

/**
 * Supported Livestream and VOD platforms (Pillar 1 §05).
 */
export const VOD_PLATFORMS = ["TWITCH", "YOUTUBE_LIVE", "KICK"] as const;
export const VodPlatformSchema = z.enum(VOD_PLATFORMS);
export type VodPlatform = z.infer<typeof VodPlatformSchema>;

/**
 * 5-second sliding window chat density / messages per second bucket.
 */
export const ChatDensityBucketSchema = z.strictObject({
  timestampSec: z.number().min(0),
  mps: z.number().min(0),
  topKeywords: z.array(z.string()),
});
export type ChatDensityBucket = z.infer<typeof ChatDensityBucketSchema>;

/**
 * Detected chat velocity spike / viral peak highlight candidate.
 */
export const ChatPeakHighlightSchema = z.strictObject({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  score: z.number().min(0).max(100),
  topEmotes: z.array(z.string()),
  reason: z.string().optional(),
});
export type ChatPeakHighlight = z.infer<typeof ChatPeakHighlightSchema>;

/**
 * Time-range selected by creator or auto-suggested for selective HLS download.
 */
export const SelectedTimeRangeSchema = z.strictObject({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});
export type SelectedTimeRange = z.infer<typeof SelectedTimeRangeSchema>;

/**
 * Request payload for probing livestream / VOD metadata and chat replay velocity.
 */
export const VodProbeRequestSchema = z.strictObject({
  url: z.string().trim().min(1),
});
export type VodProbeRequest = z.infer<typeof VodProbeRequestSchema>;

/**
 * Probe response payload with video details, timeline heatmap, and detected hype peaks.
 */
export const VodProbeResponseSchema = z.strictObject({
  platform: VodPlatformSchema,
  vodId: z.string().trim().min(1),
  title: z.string().trim(),
  channelName: z.string().trim(),
  durationSec: z.number().min(0),
  thumbnailUrl: z.string().trim(),
  isLive: z.boolean(),
  chatVelocity: z.array(ChatDensityBucketSchema),
  peaks: z.array(ChatPeakHighlightSchema),
});
export type VodProbeResponse = z.infer<typeof VodProbeResponseSchema>;

/**
 * Database representation matching StreamVodMetadata in schema.prisma.
 */
export const StreamVodMetadataSchema = z.strictObject({
  id: z.string().optional(),
  projectId: z.string(),
  platform: VodPlatformSchema,
  vodId: z.string(),
  totalDurationSec: z.number().min(0),
  chatVelocity: z.array(ChatDensityBucketSchema).nullable().optional(),
  selectedRanges: z.array(SelectedTimeRangeSchema),
});
export type StreamVodMetadata = z.infer<typeof StreamVodMetadataSchema>;

