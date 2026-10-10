import { describe, expect, it, vi } from "vitest";

import { MusicController } from "./music.controller.js";
import type { MusicService } from "./music.service.js";

describe("MusicController", () => {
  const serviceMock = {
    browse: vi.fn(),
    getById: vi.fn(),
    getRecommendations: vi.fn(),
    selectClipMusic: vi.fn(),
  } as unknown as MusicService;

  const controller = new MusicController(serviceMock);

  it("delegates browse queries to musicService.browse", async () => {
    (serviceMock.browse as any).mockResolvedValue({
      tracks: [{ id: "track-1", title: "Tech Cyber Pulse" }],
      total: 1,
      limit: 20,
      offset: 0,
      moods: ["ENERGETIC"],
      tempos: ["FAST"],
    });

    const res = await controller.browseV1({ mood: "ENERGETIC", limit: 20, offset: 0 });
    expect(res.tracks).toHaveLength(1);
    expect(serviceMock.browse).toHaveBeenCalledWith({ mood: "ENERGETIC", limit: 20, offset: 0 });
  });

  it("delegates recommend query to musicService.getRecommendations", async () => {
    (serviceMock.getRecommendations as any).mockResolvedValue([
      { id: "track-1", title: "Tech Cyber Pulse" },
    ]);

    const res = await controller.recommendV1("high_energy");
    expect(res.recommended).toHaveLength(1);
    expect(serviceMock.getRecommendations).toHaveBeenCalledWith("high_energy");
  });

  it("delegates getTrack to musicService.getById", async () => {
    (serviceMock.getById as any).mockResolvedValue({ id: "track-1", title: "Tech Cyber Pulse" });
    const res = await controller.getTrackV1("track-1");
    expect(res.id).toBe("track-1");
    expect(serviceMock.getById).toHaveBeenCalledWith("track-1");
  });

  it("delegates selectClipMusic to musicService.selectClipMusic", async () => {
    (serviceMock.selectClipMusic as any).mockResolvedValue({
      clipId: "clip-123",
      musicTrackId: "track-1",
      musicVolume: 0.15,
    });

    const res = await controller.selectClipMusicV1("clip-123", {
      musicTrackId: "track-1",
      musicVolume: 0.15,
    });

    expect(res.clipId).toBe("clip-123");
    expect(res.musicTrackId).toBe("track-1");
    expect(serviceMock.selectClipMusic).toHaveBeenCalledWith("clip-123", {
      musicTrackId: "track-1",
      musicVolume: 0.15,
    });
  });
});

