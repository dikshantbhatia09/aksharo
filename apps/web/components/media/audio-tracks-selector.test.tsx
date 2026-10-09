import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AudioTracksSelector, type AudioTrackItem } from "./audio-tracks-selector";

const mockTracks: AudioTrackItem[] = [
  {
    id: "track-1",
    mediaId: "media-1",
    streamIndex: 0,
    channelIndex: 0,
    label: "Host Mic",
    speakerLabel: "Host",
    isDialogue: true,
    sampleRate: 16000,
    channels: 1,
    durationMs: 60000,
  },
  {
    id: "track-2",
    mediaId: "media-1",
    streamIndex: 1,
    channelIndex: 0,
    label: "Guest Mic",
    speakerLabel: "Guest",
    isDialogue: true,
    sampleRate: 16000,
    channels: 1,
    durationMs: 60000,
  },
  {
    id: "track-3",
    mediaId: "media-1",
    streamIndex: 2,
    channelIndex: 0,
    label: "Game Audio",
    speakerLabel: null,
    isDialogue: false,
    sampleRate: 16000,
    channels: 1,
    durationMs: 60000,
  },
];

describe("<AudioTracksSelector />", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders tracks from initialTracks prop", () => {
    render(
      <AudioTracksSelector
        projectId="proj-1"
        mediaId="media-1"
        initialTracks={mockTracks}
      />,
    );

    expect(screen.getByText("Audio Tracks & Speaker Separation")).toBeInTheDocument();
    expect(screen.getByText("Host Mic")).toBeInTheDocument();
    expect(screen.getByText("Guest Mic")).toBeInTheDocument();
    expect(screen.getByText("Game Audio")).toBeInTheDocument();
    expect(screen.getByText("Stream 0:Ch 0")).toBeInTheDocument();
    expect(screen.getByText("Stream 1:Ch 0")).toBeInTheDocument();
  });

  it("fetches tracks when initialTracks is not provided", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTracks,
    });

    render(
      <AudioTracksSelector
        projectId="proj-1"
        mediaId="media-1"
      />,
    );

    expect(screen.getByText("Detecting audio tracks...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Host Mic")).toBeInTheDocument();
      expect(screen.getByText("Guest Mic")).toBeInTheDocument();
    });
  });

  it("toggles dialogue state on button click", async () => {
    const onTracksUpdated = vi.fn();
    const updatedTrack: AudioTrackItem = {
      ...mockTracks[0]!,
      isDialogue: false,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => updatedTrack,
    });

    render(
      <AudioTracksSelector
        projectId="proj-1"
        mediaId="media-1"
        initialTracks={mockTracks}
        onTracksUpdated={onTracksUpdated}
      />,
    );

    const toggleBtn = screen.getByTestId("toggle-dialogue-track-1");
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/v1/projects/proj-1/media/media-1/audio-tracks/track-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ isDialogue: false }),
        }),
      );
      expect(onTracksUpdated).toHaveBeenCalled();
    });
  });

  it("updates speaker label on input blur", async () => {
    const onTracksUpdated = vi.fn();
    const updatedTrack: AudioTrackItem = {
      ...mockTracks[1]!,
      speakerLabel: "Dr. Smith",
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => updatedTrack,
    });

    render(
      <AudioTracksSelector
        projectId="proj-1"
        mediaId="media-1"
        initialTracks={mockTracks}
        onTracksUpdated={onTracksUpdated}
      />,
    );

    const speakerInput = screen.getByTestId("speaker-input-track-2");
    fireEvent.change(speakerInput, { target: { value: "Dr. Smith" } });
    fireEvent.blur(speakerInput);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/v1/projects/proj-1/media/media-1/audio-tracks/track-2",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ speakerLabel: "Dr. Smith" }),
        }),
      );
      expect(onTracksUpdated).toHaveBeenCalled();
    });
  });

  it("renders empty state when no tracks are detected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    render(
      <AudioTracksSelector
        projectId="proj-1"
        mediaId="media-1"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("No multi-track audio detected. Using standard single-track downmix."),
      ).toBeInTheDocument();
    });
  });
});
