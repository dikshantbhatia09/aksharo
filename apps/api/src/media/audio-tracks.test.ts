import { describe, expect, it, vi } from "vitest";

import { MediaService } from "./media.service.js";

describe("MediaService - Audio Tracks (Feature 08)", () => {
  it("getAudioTracks queries media_audio_tracks by mediaAssetId ordered by stream and channel index", async () => {
    const mockPrisma = {
      mediaAsset: {
        findFirst: vi.fn().mockResolvedValue({
          id: "01JCMED0000000000000000000",
          projectId: "01JCPROJ000000000000000000",
          role: "primary",
          project: { workspaceId: "01JCWS00000000000000000000" },
        }),
      },
      mediaAudioTrack: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "track-1",
            mediaAssetId: "01JCMED0000000000000000000",
            streamIndex: 0,
            channelIndex: 0,
            label: "Host Mic",
            audioWavUri: "ws/1/p/1/media/1/tracks/track_0.wav",
            durationMs: 60000,
            isDialogue: true,
            speakerName: "Host",
          },
          {
            id: "track-2",
            mediaAssetId: "01JCMED0000000000000000000",
            streamIndex: 1,
            channelIndex: 0,
            label: "Guest Audio",
            audioWavUri: "ws/1/p/1/media/1/tracks/track_1.wav",
            durationMs: 60000,
            isDialogue: true,
            speakerName: "Guest",
          },
        ]),
      },
    };

    const service = new MediaService(
      mockPrisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const tracks = await service.getAudioTracks(
      "01JCWS00000000000000000000",
      "01JCPROJ000000000000000000",
      "01JCMED0000000000000000000",
    );

    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.label).toBe("Host Mic");
    expect(tracks[1]?.label).toBe("Guest Audio");
    expect(mockPrisma.mediaAudioTrack.findMany).toHaveBeenCalledWith({
      where: { mediaAssetId: "01JCMED0000000000000000000" },
      orderBy: [{ streamIndex: "asc" }, { channelIndex: "asc" }],
    });
  });

  it("updateAudioTrack updates dialogue flag, speaker name, and label", async () => {
    const mockPrisma = {
      mediaAsset: {
        findFirst: vi.fn().mockResolvedValue({
          id: "01JCMED0000000000000000000",
          projectId: "01JCPROJ000000000000000000",
          role: "primary",
          project: { workspaceId: "01JCWS00000000000000000000" },
        }),
      },
      mediaAudioTrack: {
        findFirst: vi.fn().mockResolvedValue({
          id: "track-3",
          mediaAssetId: "01JCMED0000000000000000000",
          isDialogue: true,
          speakerName: "Speaker 3",
          label: "Desktop Audio",
        }),
        update: vi.fn().mockResolvedValue({
          id: "track-3",
          mediaAssetId: "01JCMED0000000000000000000",
          isDialogue: false,
          speakerName: null,
          label: "Muted Game Audio",
        }),
      },
    };

    const service = new MediaService(
      mockPrisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const updated = await service.updateAudioTrack(
      "01JCWS00000000000000000000",
      "01JCPROJ000000000000000000",
      "01JCMED0000000000000000000",
      "track-3",
      { isDialogue: false, speakerName: null, label: "Muted Game Audio" },
    );

    expect(updated.isDialogue).toBe(false);
    expect(updated.label).toBe("Muted Game Audio");
    expect(mockPrisma.mediaAudioTrack.update).toHaveBeenCalledWith({
      where: { id: "track-3" },
      data: { isDialogue: false, speakerName: null, label: "Muted Game Audio" },
    });
  });
});
