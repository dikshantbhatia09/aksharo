import { z } from "zod";

export const musicTrackMoodSchema = z.enum([
  "ENERGETIC",
  "CHILL",
  "DRAMATIC",
  "CORPORATE",
  "INSPIRATIONAL",
  "MYSTERIOUS",
]);

export type MusicTrackMood = z.infer<typeof musicTrackMoodSchema>;

export const musicTrackTempoSchema = z.enum(["SLOW", "MEDIUM", "FAST"]);
export type MusicTrackTempo = z.infer<typeof musicTrackTempoSchema>;

export const musicTrackDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  mood: z.string(),
  tempo: z.string(),
  bpm: z.number().nullable(),
  durationSec: z.number(),
  previewUri: z.string(),
  masterUri: z.string(),
  waveform: z.array(z.number()),
  waveformJson: z.string().nullable().optional(),
  isPublic: z.boolean(),
  createdAt: z.string(),
});

export type MusicTrackDto = z.infer<typeof musicTrackDtoSchema>;

export const musicBrowseQuerySchema = z.object({
  mood: z.string().optional(),
  tempo: z.string().optional(),
  search: z.string().optional(),
  minBpm: z.coerce.number().optional(),
  maxBpm: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  recommendForMood: z.string().optional(),
});

export type MusicBrowseQueryDto = z.infer<typeof musicBrowseQuerySchema>;

export const musicBrowseResponseSchema = z.object({
  tracks: z.array(musicTrackDtoSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  moods: z.array(z.string()),
  tempos: z.array(z.string()),
  recommended: z.array(musicTrackDtoSchema).optional(),
});

export type MusicBrowseResponseDto = z.infer<typeof musicBrowseResponseSchema>;

export const selectClipMusicSchema = z.object({
  musicTrackId: z.string().nullable(),
  musicVolume: z.number().min(0).max(1).default(0.15),
});

export type SelectClipMusicDto = z.infer<typeof selectClipMusicSchema>;

export const clipMusicSelectionResultSchema = z.object({
  clipId: z.string(),
  musicTrackId: z.string().nullable(),
  musicVolume: z.number(),
  track: musicTrackDtoSchema.nullable().optional(),
});

export type ClipMusicSelectionResult = z.infer<typeof clipMusicSelectionResultSchema>;

