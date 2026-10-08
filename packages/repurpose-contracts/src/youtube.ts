import { z } from "zod";

/**
 * YouTube native chapter representation (Pillar 1 §01).
 * Extracted from yt-dlp metadata JSON (`parsed.chapters`).
 */
export const YouTubeNativeChapterSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});
export type YouTubeNativeChapter = z.infer<typeof YouTubeNativeChapterSchema>;

/**
 * YouTube fast metadata probe request payload.
 */
export const YouTubeProbeRequestSchema = z.strictObject({
  url: z.string().trim().min(1),
});
export type YouTubeProbeRequest = z.infer<typeof YouTubeProbeRequestSchema>;

/**
 * YouTube fast metadata probe response payload (SLA <= 1.8s).
 * Meets Section 4.2 of Direct YouTube URL Import specification.
 */
export const YouTubeProbeResponseSchema = z.strictObject({
  videoId: z.string().trim().min(1),
  title: z.string().trim(),
  channelName: z.string().trim(),
  durationSec: z.number().min(0),
  thumbnailUrl: z.string().trim(),
  isLiveStream: z.boolean(),
  hasCaptions: z.boolean(),
  nativeChapters: z.array(YouTubeNativeChapterSchema),
});
export type YouTubeProbeResponse = z.infer<typeof YouTubeProbeResponseSchema>;

