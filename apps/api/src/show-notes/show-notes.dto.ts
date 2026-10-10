import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * YouTube interactive chapter format strictly following YouTube constraints:
 * - Starts at 00:00 (startSec = 0)
 * - Minimum 3 timestamps in ascending order
 * - Delta t >= 10s
 */
export const youtubeChapterSchema = z.object({
  timestamp: z.string().trim().regex(/^(?:\d{1,2}:)?\d{2}:\d{2}$/, "Must be mm:ss or hh:mm:ss format"),
  title: z.string().trim().min(1).max(100),
  startSec: z.number().int().min(0),
});

export type YouTubeChapterDto = z.infer<typeof youtubeChapterSchema>;

export const notableQuoteSchema = z.object({
  speaker: z.string().trim().min(1).max(64),
  quote: z.string().trim().min(1).max(500),
  timestampSec: z.number().int().min(0),
});

export type NotableQuoteDto = z.infer<typeof notableQuoteSchema>;

export const projectShowNotesSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  summary: z.string().min(1),
  keyTakeaways: z.array(z.string().min(1)).min(3),
  notableQuotes: z.array(notableQuoteSchema),
  youtubeChapters: z.array(youtubeChapterSchema).min(3),
  createdAt: z.string(),
});

export type ProjectShowNotesView = z.infer<typeof projectShowNotesSchema>;

export const generateShowNotesSchema = z.object({
  forceRegenerate: z.boolean().optional().default(false),
});

export class GenerateShowNotesDto extends zodDto(generateShowNotesSchema) {}

export const updateShowNotesSchema = z
  .object({
    summary: z.string().min(1).optional(),
    keyTakeaways: z.array(z.string().min(1)).min(1).optional(),
    notableQuotes: z.array(notableQuoteSchema).optional(),
    youtubeChapters: z.array(youtubeChapterSchema).min(3).optional(),
  })
  .refine((val) => Object.keys(val).length > 0, "At least one field must be provided to update");

export class UpdateShowNotesDto extends zodDto(updateShowNotesSchema) {}

