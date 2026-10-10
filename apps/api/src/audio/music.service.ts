import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import {
  type ClipMusicSelectionResult,
  type MusicBrowseQueryDto,
  type MusicBrowseResponseDto,
  type MusicTrackDto,
  type SelectClipMusicDto,
  musicBrowseQuerySchema,
  selectClipMusicSchema,
} from "./music.dto.js";
import { AppException } from "../common/index.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

const DEFAULT_WAVEFORM = [0.1, 0.3, 0.6, 0.8, 0.5, 0.7, 0.9, 0.4, 0.2, 0.5];

export function parseWaveform(json: string | null | undefined): number[] {
  if (!json) return DEFAULT_WAVEFORM;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
      return parsed;
    }
  } catch {
    // fallback
  }
  return DEFAULT_WAVEFORM;
}

export function mapSemanticMood(inputMood?: string): string {
  if (!inputMood) return "ENERGETIC";
  const normalized = inputMood.trim().toUpperCase();

  if (["ENERGETIC", "HIGH_ENERGY", "HYPE", "STARTUP", "ACTION", "UPBEAT"].includes(normalized)) {
    return "ENERGETIC";
  }
  if (["CHILL", "LOFI", "LO_FI", "CASUAL", "BANTER", "RELAXED", "COMEDY"].includes(normalized)) {
    return "CHILL";
  }
  if (["DRAMATIC", "TENSION", "SERIOUS", "MELANCHOLY", "SAD", "STORY"].includes(normalized)) {
    return "DRAMATIC";
  }
  if (["CORPORATE", "BUSINESS", "TECH", "EXPLAINER", "PROFESSIONAL"].includes(normalized)) {
    return "CORPORATE";
  }
  if (["INSPIRATIONAL", "UPLIFTING", "MOTIVATIONAL", "JOURNEY", "GROWTH"].includes(normalized)) {
    return "INSPIRATIONAL";
  }
  if (["MYSTERIOUS", "INVESTIGATION", "PUZZLE", "ENIGMATIC", "THRILLER"].includes(normalized)) {
    return "MYSTERIOUS";
  }

  return "ENERGETIC";
}

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);

  constructor(private readonly prisma: PrismaService) {}

  async browse(rawQuery: MusicBrowseQueryDto = {} as any): Promise<MusicBrowseResponseDto> {
    const query = musicBrowseQuerySchema.parse(rawQuery ?? {});
    const where: Prisma.MusicTrackWhereInput = {
      isPublic: true,
    };

    if (query.mood && query.mood.trim() !== "" && query.mood.toUpperCase() !== "ALL") {
      where.mood = {
        equals: query.mood.trim().toUpperCase(),
        mode: "insensitive",
      };
    }

    if (query.tempo && query.tempo.trim() !== "" && query.tempo.toUpperCase() !== "ALL") {
      where.tempo = {
        equals: query.tempo.trim().toUpperCase(),
        mode: "insensitive",
      };
    }

    if (query.search && query.search.trim() !== "") {
      const term = query.search.trim();
      where.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { artist: { contains: term, mode: "insensitive" } },
        { mood: { contains: term, mode: "insensitive" } },
      ];
    }

    if (query.minBpm !== undefined || query.maxBpm !== undefined) {
      where.bpm = {};
      if (query.minBpm !== undefined) where.bpm.gte = query.minBpm;
      if (query.maxBpm !== undefined) where.bpm.lte = query.maxBpm;
    }

    const [tracks, total, allMoods, allTempos] = await Promise.all([
      this.prisma.musicTrack.findMany({
        where,
        take: query.limit,
        skip: query.offset,
        orderBy: [{ mood: "asc" }, { title: "asc" }],
      }),
      this.prisma.musicTrack.count({ where }),
      this.prisma.musicTrack.findMany({
        where: { isPublic: true },
        select: { mood: true },
        distinct: ["mood"],
      }),
      this.prisma.musicTrack.findMany({
        where: { isPublic: true },
        select: { tempo: true },
        distinct: ["tempo"],
      }),
    ]);

    const mappedTracks: MusicTrackDto[] = tracks.map((t) => this.toDto(t));

    let recommended: MusicTrackDto[] | undefined;
    if (query.recommendForMood) {
      const targetMood = mapSemanticMood(query.recommendForMood);
      const recs = await this.prisma.musicTrack.findMany({
        where: { isPublic: true, mood: targetMood },
        take: 5,
        orderBy: { title: "asc" },
      });
      recommended = recs.map((t) => this.toDto(t));
    }

    return {
      tracks: mappedTracks,
      total,
      limit: query.limit,
      offset: query.offset,
      moods: allMoods.map((m) => m.mood),
      tempos: allTempos.map((t) => t.tempo),
      ...(recommended ? { recommended } : {}),
    };
  }

  async getById(id: string): Promise<MusicTrackDto> {
    const track = await this.prisma.musicTrack.findUnique({
      where: { id },
    });
    if (!track) {
      throw new AppException("music/not_found", `Music track '${id}' not found`, HttpStatus.NOT_FOUND);
    }
    return this.toDto(track);
  }

  async getRecommendations(mood?: string, limit = 5): Promise<MusicTrackDto[]> {
    const targetMood = mapSemanticMood(mood);
    const tracks = await this.prisma.musicTrack.findMany({
      where: {
        isPublic: true,
        mood: targetMood,
      },
      take: Math.min(Math.max(1, limit), 20),
      orderBy: { createdAt: "desc" },
    });
    return tracks.map((t) => this.toDto(t));
  }

  async selectClipMusic(
    clipId: string,
    rawInput: SelectClipMusicDto,
  ): Promise<ClipMusicSelectionResult> {
    const input = selectClipMusicSchema.parse(rawInput ?? {});
    let trackDto: MusicTrackDto | null = null;
    if (input.musicTrackId) {
      trackDto = await this.getById(input.musicTrackId);
    }

    const volume = Math.max(0, Math.min(1, input.musicVolume ?? 0.15));

    // Try updating repurposeClip if it exists
    const repurposeClip = await this.prisma.repurposeClip.findUnique({
      where: { id: clipId },
    });

    if (repurposeClip) {
      await this.prisma.repurposeClip.update({
        where: { id: clipId },
        data: {
          musicTrackId: input.musicTrackId,
          musicVolume: volume,
        },
      });
    }

    this.logger.log(
      `Clip ${clipId} background music updated: track=${input.musicTrackId ?? "none"}, volume=${volume}`,
    );

    return {
      clipId,
      musicTrackId: input.musicTrackId,
      musicVolume: volume,
      track: trackDto,
    };
  }

  private toDto(track: {
    id: string;
    title: string;
    artist: string;
    mood: string;
    tempo: string;
    bpm: number | null;
    durationSec: number;
    previewUri: string;
    masterUri: string;
    waveformJson: string | null;
    isPublic: boolean;
    createdAt: Date;
  }): MusicTrackDto {
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      mood: track.mood,
      tempo: track.tempo,
      bpm: track.bpm,
      durationSec: track.durationSec,
      previewUri: track.previewUri,
      masterUri: track.masterUri,
      waveform: parseWaveform(track.waveformJson),
      waveformJson: track.waveformJson,
      isPublic: track.isPublic,
      createdAt: track.createdAt.toISOString(),
    };
  }
}

