import { z } from "zod";

export const connectPodcastSchema = z.object({
  feedUrl: z.string().trim().url({ message: "Must be a valid podcast RSS URL" }),
  autoRepurpose: z.boolean().optional().default(true),
});
export type ConnectPodcastDto = z.infer<typeof connectPodcastSchema>;

export const searchPodcastsQuerySchema = z.object({
  q: z.string().trim().min(1, { message: "Search term required" }).max(200),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
});
export type SearchPodcastsQueryDto = z.infer<typeof searchPodcastsQuerySchema>;

export const updatePodcastShowSchema = z.object({
  autoRepurpose: z.boolean().optional(),
});
export type UpdatePodcastShowDto = z.infer<typeof updatePodcastShowSchema>;

export const repurposeEpisodeSchema = z.object({
  styleId: z.string().optional(),
  sourceLanguage: z.string().optional().default("auto"),
  brand: z.boolean().optional().default(false),
  topic: z.string().optional(),
});
export type RepurposeEpisodeDto = z.infer<typeof repurposeEpisodeSchema>;

export const podcastChapterSchema = z.object({
  title: z.string(),
  startSec: z.number(),
  endSec: z.number().optional(),
});
export type PodcastChapterDto = z.infer<typeof podcastChapterSchema>;

export const podcastEpisodeViewSchema = z.object({
  id: z.string(),
  showId: z.string(),
  guid: z.string(),
  title: z.string(),
  audioUrl: z.string(),
  durationSec: z.number().nullable().optional(),
  publishedAt: z.string(),
  isProcessed: z.boolean(),
  projectId: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  chapters: z.array(podcastChapterSchema).optional(),
  createdAt: z.string(),
});
export type PodcastEpisodeViewDto = z.infer<typeof podcastEpisodeViewSchema>;

export const podcastShowViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  feedUrl: z.string(),
  author: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  lastBuildDate: z.string().nullable().optional(),
  autoRepurpose: z.boolean(),
  episodeCount: z.number().int().optional(),
  episodes: z.array(podcastEpisodeViewSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PodcastShowViewDto = z.infer<typeof podcastShowViewSchema>;

export const podcastShowListSchema = z.object({
  shows: z.array(podcastShowViewSchema),
});
export type PodcastShowListDto = z.infer<typeof podcastShowListSchema>;

