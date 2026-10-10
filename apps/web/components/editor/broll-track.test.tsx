import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  BrollTrack,
  type BrollCueItem,
  type StockAlternative,
} from "./broll-track.js";

const TEST_CUES: BrollCueItem[] = [
  {
    id: "cue-1",
    startSec: 4.0,
    endSec: 7.5,
    query: "Facebook ad spend dashboard",
    stockVideoUri: "https://assets.aksharo.com/stock/ads.mp4",
    sourceProvider: "STORYBLOCKS",
    status: "ACTIVE",
  },
  {
    id: "cue-2",
    startSec: 18.0,
    endSec: 21.5,
    query: "Luxury real estate market collapse",
    stockVideoUri: "https://assets.aksharo.com/stock/realestate.mp4",
    sourceProvider: "STORYBLOCKS",
    status: "ACTIVE",
  },
];

describe("BrollTrack Component (Pillar 6 §01)", () => {
  it("renders visual timeline blocks for each active B-roll cue", () => {
    const onSwap = vi.fn();
    render(
      <BrollTrack
        cues={TEST_CUES}
        totalDurationSec={60.0}
        currentTimeSec={5.0}
        onSwapVideo={onSwap}
      />,
    );

    expect(screen.getByTestId("broll-track-container")).toBeDefined();
    expect(screen.getByTestId("broll-timeline-lane")).toBeDefined();
    expect(screen.getByTestId("broll-cue-block-cue-1")).toBeDefined();
    expect(screen.getByTestId("broll-cue-block-cue-2")).toBeDefined();

    expect(screen.getByText("Facebook ad spend dashboard")).toBeDefined();
    expect(screen.getByText("Luxury real estate market collapse")).toBeDefined();
  });

  it("opens swap modal with 6 alternative stock video clips on clicking a cue block", () => {
    const onSwap = vi.fn();
    render(
      <BrollTrack
        cues={TEST_CUES}
        totalDurationSec={60.0}
        onSwapVideo={onSwap}
      />,
    );

    // Modal is initially not rendered
    expect(screen.queryByTestId("broll-swap-modal")).toBeNull();

    // Click cue 1
    fireEvent.click(screen.getByTestId("broll-cue-block-cue-1"));

    // Modal appears
    expect(screen.getByTestId("broll-swap-modal")).toBeDefined();
    expect(screen.getByText(/Swap B-Roll Stock Footage/i)).toBeDefined();

    // Verify alternative cards
    const grid = screen.getByTestId("broll-alternatives-grid");
    expect(grid).toBeDefined();
    expect(screen.getByTestId("broll-alt-card-alt-ads-01")).toBeDefined();
    expect(screen.getByTestId("broll-alt-card-alt-realestate-02")).toBeDefined();
    expect(screen.getByTestId("broll-alt-card-alt-rocket-03")).toBeDefined();
  });

  it("triggers onSwapVideo when an alternative stock clip is clicked and closes modal", () => {
    const onSwap = vi.fn();
    render(
      <BrollTrack
        cues={TEST_CUES}
        totalDurationSec={60.0}
        onSwapVideo={onSwap}
      />,
    );

    fireEvent.click(screen.getByTestId("broll-cue-block-cue-1"));

    // Click alternative 2
    fireEvent.click(screen.getByTestId("broll-alt-card-alt-realestate-02"));

    expect(onSwap).toHaveBeenCalledWith(
      "cue-1",
      "https://assets.aksharo.com/stock/videos/luxury-real-estate-vertical-1080p.mp4",
      "STORYBLOCKS",
    );

    // Modal closes
    expect(screen.queryByTestId("broll-swap-modal")).toBeNull();
  });

  it("supports muting and deleting a cue", () => {
    const onMute = vi.fn();
    const onDelete = vi.fn();

    render(
      <BrollTrack
        cues={TEST_CUES}
        totalDurationSec={60.0}
        onSwapVideo={vi.fn()}
        onToggleMute={onMute}
        onDeleteCue={onDelete}
      />,
    );

    const muteBtn = screen.getByTestId("broll-mute-btn-cue-1");
    fireEvent.click(muteBtn);
    expect(onMute).toHaveBeenCalledWith("cue-1");

    const deleteBtn = screen.getByTestId("broll-delete-btn-cue-2");
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith("cue-2");
  });

  it("allows searching for custom stock footage in modal", async () => {
    const customAlternatives: StockAlternative[] = [
      {
        id: "custom-01",
        title: "Drone Mountain Mist 4K",
        provider: "PEXELS",
        durationSec: 12.0,
        videoUrl: "https://videos.pexels.com/custom.mp4",
        previewImageUrl: "https://images.pexels.com/preview.jpg",
        resolution: "1080p",
      },
    ];

    const onSearchStock = vi.fn().mockResolvedValue(customAlternatives);

    render(
      <BrollTrack
        cues={TEST_CUES}
        totalDurationSec={60.0}
        onSwapVideo={vi.fn()}
        onSearchStock={onSearchStock}
      />,
    );

    fireEvent.click(screen.getByTestId("broll-cue-block-cue-1"));

    const searchInput = screen.getByTestId("broll-search-input");
    fireEvent.change(searchInput, { target: { value: "mountain mist" } });
    fireEvent.click(screen.getByTestId("broll-search-submit-btn"));

    await waitFor(() => {
      expect(onSearchStock).toHaveBeenCalledWith("mountain mist");
      expect(screen.getByTestId("broll-alt-card-custom-01")).toBeDefined();
    });
  });
});

