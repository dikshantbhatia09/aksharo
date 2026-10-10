import { describe, expect, it, vi } from "vitest";

import { mapSemanticMood, MusicService, parseWaveform } from "./music.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";

const MOCK_TRACKS = [
  {
    id: "track-1",
    title: "Tech Cyber Pulse",
    artist: "Aksharo Originals",
    mood: "ENERGETIC",
    tempo: "FAST",
    bpm: 128,
    durationSec: 154.0,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/tech-cyber-pulse.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/tech-cyber-pulse.wav",
    waveformJson: "[0.1, 0.4, 0.8, 0.2]",
    isPublic: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  },
  {
    id: "track-2",
    title: "Coffee & Code Lo-Fi",
    artist: "Aksharo Originals",
    mood: "CHILL",
    tempo: "SLOW",
    bpm: 78,
    durationSec: 180.0,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/coffee-and-code-lofi.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/coffee-and-code-lofi.wav",
    waveformJson: "[0.2, 0.3, 0.5, 0.1]",
    isPublic: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  },
  {
    id: "track-3",
    title: "Cinematic Piano Melancholy",
    artist: "Aksharo Originals",
    mood: "DRAMATIC",
    tempo: "SLOW",
    bpm: 68,
    durationSec: 190.0,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/cinematic-piano-melancholy.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/cinematic-piano-melancholy.wav",
    waveformJson: "[0.05, 0.2, 0.6, 0.4]",
    isPublic: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  },
];

describe("MusicService", () => {
  const prismaMock = {
    musicTrack: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    repurposeClip: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaService;

  const service = new MusicService(prismaMock);

  describe("waveform parsing", () => {
    it("parses valid JSON array of numbers", () => {
      expect(parseWaveform("[0.1, 0.5, 0.9]")).toEqual([0.1, 0.5, 0.9]);
    });

    it("falls back to default waveform on invalid or null JSON", () => {
      const fallback = parseWaveform(null);
      expect(fallback.length).toBeGreaterThan(0);
      expect(parseWaveform("not json")).toEqual(fallback);
    });
  });

  describe("semantic mood mapping", () => {
    it("maps high energy tags to ENERGETIC", () => {
      expect(mapSemanticMood("high_energy")).toBe("ENERGETIC");
      expect(mapSemanticMood("startup")).toBe("ENERGETIC");
      expect(mapSemanticMood("hype")).toBe("ENERGETIC");
      expect(mapSemanticMood("action")).toBe("ENERGETIC");
    });

    it("maps comedy and banter to CHILL", () => {
      expect(mapSemanticMood("comedy")).toBe("CHILL");
      expect(mapSemanticMood("lofi")).toBe("CHILL");
      expect(mapSemanticMood("banter")).toBe("CHILL");
    });

    it("maps serious lessons to DRAMATIC", () => {
      expect(mapSemanticMood("melancholy")).toBe("DRAMATIC");
      expect(mapSemanticMood("story")).toBe("DRAMATIC");
      expect(mapSemanticMood("tension")).toBe("DRAMATIC");
    });

    it("maps business to CORPORATE and journey to INSPIRATIONAL", () => {
      expect(mapSemanticMood("business")).toBe("CORPORATE");
      expect(mapSemanticMood("uplifting")).toBe("INSPIRATIONAL");
      expect(mapSemanticMood("investigation")).toBe("MYSTERIOUS");
    });
  });

  describe("browse", () => {
    it("browses catalog with filters and pagination", async () => {
      (prismaMock.musicTrack.findMany as any).mockImplementation((args: any) => {
        if (args?.distinct) {
          if (args.distinct.includes("mood")) return Promise.resolve([{ mood: "ENERGETIC" }, { mood: "CHILL" }]);
          if (args.distinct.includes("tempo")) return Promise.resolve([{ tempo: "FAST" }, { tempo: "SLOW" }]);
        }
        return Promise.resolve([MOCK_TRACKS[0]]);
      });
      (prismaMock.musicTrack.count as any).mockResolvedValue(1);

      const result = await service.browse({
        mood: "ENERGETIC",
        tempo: "FAST",
        limit: 10,
        offset: 0,
      });

      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0]!.id).toBe("track-1");
      expect(result.tracks[0]!.title).toBe("Tech Cyber Pulse");
      expect(result.tracks[0]!.waveform).toEqual([0.1, 0.4, 0.8, 0.2]);
      expect(result.total).toBe(1);
    });
  });

  describe("getById", () => {
    it("returns track when found", async () => {
      (prismaMock.musicTrack.findUnique as any).mockResolvedValue(MOCK_TRACKS[0]);
      const track = await service.getById("track-1");
      expect(track.id).toBe("track-1");
      expect(track.artist).toBe("Aksharo Originals");
    });

    it("throws 404 when track is not found", async () => {
      (prismaMock.musicTrack.findUnique as any).mockResolvedValue(null);
      await expect(service.getById("track-999")).rejects.toThrow();
    });
  });

  describe("selectClipMusic", () => {
    it("attaches music track and clamps volume", async () => {
      (prismaMock.musicTrack.findUnique as any).mockResolvedValue(MOCK_TRACKS[0]);
      (prismaMock.repurposeClip.findUnique as any).mockResolvedValue({ id: "clip-123" });
      (prismaMock.repurposeClip.update as any).mockResolvedValue({ id: "clip-123" });

      const result = await service.selectClipMusic("clip-123", {
        musicTrackId: "track-1",
        musicVolume: 0.15,
      });

      expect(result.clipId).toBe("clip-123");
      expect(result.musicTrackId).toBe("track-1");
      expect(result.musicVolume).toBe(0.15);
      expect(result.track?.title).toBe("Tech Cyber Pulse");
    });

    it("allows removing music by passing null trackId", async () => {
      (prismaMock.repurposeClip.findUnique as any).mockResolvedValue({ id: "clip-123" });
      (prismaMock.repurposeClip.update as any).mockResolvedValue({ id: "clip-123" });

      const result = await service.selectClipMusic("clip-123", {
        musicTrackId: null,
        musicVolume: 0,
      });

      expect(result.clipId).toBe("clip-123");
      expect(result.musicTrackId).toBeNull();
      expect(result.musicVolume).toBe(0);
      expect(result.track).toBeNull();
    });
  });
});

