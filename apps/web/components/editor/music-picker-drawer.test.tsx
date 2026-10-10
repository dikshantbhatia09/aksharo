import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MusicPickerDrawer } from "./music-picker-drawer";

describe("<MusicPickerDrawer />", () => {
  beforeEach(() => {
    // Mock global Audio
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tracks: [
            {
              id: "track-eng-001",
              title: "Tech Cyber Pulse",
              artist: "Aksharo Originals",
              mood: "ENERGETIC",
              tempo: "FAST",
              bpm: 128,
              durationSec: 154,
              previewUri: "https://cdn.aksharo.com/audio/music/previews/tech-cyber-pulse.mp3",
              masterUri: "https://cdn.aksharo.com/audio/music/masters/tech-cyber-pulse.wav",
              waveform: [0.1, 0.4, 0.7, 0.9],
              isPublic: true,
            },
            {
              id: "track-chl-001",
              title: "Coffee & Code Lo-Fi",
              artist: "Aksharo Originals",
              mood: "CHILL",
              tempo: "SLOW",
              bpm: 78,
              durationSec: 180,
              previewUri: "https://cdn.aksharo.com/audio/music/previews/coffee-and-code-lofi.mp3",
              masterUri: "https://cdn.aksharo.com/audio/music/masters/coffee-and-code-lofi.wav",
              waveform: [0.2, 0.3, 0.5],
              isPublic: true,
            },
          ],
        }),
      }),
    );
  });

  it("renders the royalty-free music drawer with mood pills and track list", async () => {
    render(<MusicPickerDrawer />);
    expect(screen.getByTestId("music-picker-drawer")).toBeInTheDocument();
    expect(screen.getByText("Royalty-Free Music")).toBeInTheDocument();
    expect(screen.getByText("Commercial-Safe")).toBeInTheDocument();
    expect(screen.getByTestId("music-search-input")).toBeInTheDocument();
    expect(screen.getByTestId("mood-pill-energetic")).toBeInTheDocument();
    expect(screen.getByTestId("mood-pill-chill")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Tech Cyber Pulse")).toBeInTheDocument();
    });
  });

  it("filters by search query", async () => {
    const user = userEvent.setup();
    render(<MusicPickerDrawer />);

    const searchInput = screen.getByTestId("music-search-input");
    await user.type(searchInput, "Coffee");

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("search=Coffee"));
  });

  it("filters when clicking a mood pill", async () => {
    const user = userEvent.setup();
    render(<MusicPickerDrawer />);

    await user.click(screen.getByTestId("mood-pill-chill"));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("mood=CHILL"));
  });

  it("toggles track audition playback on play button click", async () => {
    const user = userEvent.setup();
    render(<MusicPickerDrawer />);

    await waitFor(() => {
      expect(screen.getByTestId("play-btn-track-eng-001")).toBeInTheDocument();
    });

    const playBtn = screen.getByTestId("play-btn-track-eng-001");
    await user.click(playBtn);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("allows selecting a track and fires onSelectTrack callback", async () => {
    const user = userEvent.setup();
    const onSelectTrack = vi.fn();
    render(<MusicPickerDrawer onSelectTrack={onSelectTrack} appliedVolume={0.15} />);

    await waitFor(() => {
      expect(screen.getByTestId("apply-btn-track-eng-001")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("apply-btn-track-eng-001"));
    expect(onSelectTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "track-eng-001", title: "Tech Cyber Pulse" }),
      0.15,
    );
  });

  it("adjusts volume slider and updates level", async () => {
    const onSelectTrack = vi.fn();
    render(
      <MusicPickerDrawer
        appliedTrackId="track-eng-001"
        appliedVolume={0.15}
        onSelectTrack={onSelectTrack}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("music-volume-slider")).toBeInTheDocument();
    });

    const slider = screen.getByTestId("music-volume-slider");
    fireEvent.change(slider, { target: { value: "0.25" } });

    expect(onSelectTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "track-eng-001" }),
      0.25,
    );
  });
});

