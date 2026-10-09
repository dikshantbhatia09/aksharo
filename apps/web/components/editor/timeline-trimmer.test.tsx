import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { TimelineTrimmer } from "./timeline-trimmer";

import type { TimedWord } from "@montaj/repurpose-contracts";

const SAMPLE_WORDS: TimedWord[] = [
  { id: "w0", text: "Wait", start: 8.2, end: 8.6 },
  { id: "w1", text: "Most", start: 10.0, end: 10.4 },
  { id: "w2", text: "founders", start: 10.45, end: 11.0 },
  { id: "w3", text: "fail", start: 11.05, end: 11.5 },
  { id: "w4", text: "because", start: 11.55, end: 12.1 },
  { id: "w5", text: "they", start: 12.15, end: 12.5 },
  { id: "w6", text: "ignore", start: 12.55, end: 13.1 },
  { id: "w7", text: "distribution.", start: 13.15, end: 16.0 },
  { id: "w8", text: "And", start: 18.0, end: 18.4 },
  { id: "w9", text: "that's", start: 18.45, end: 18.9 },
  { id: "w10", text: "the", start: 18.95, end: 19.2 },
  { id: "w11", text: "whole", start: 19.25, end: 19.6 },
  { id: "w12", text: "game.", start: 19.65, end: 20.4 },
];

describe("<TimelineTrimmer />", () => {
  it("renders dual handles, waveform bars, millisecond timecode inputs, and live caption preview", () => {
    render(
      <TimelineTrimmer
        startSec={10.0}
        endSec={16.0}
        aiStartSec={10.0}
        aiEndSec={16.0}
        videoDurationSec={120}
        words={SAMPLE_WORDS}
      />,
    );

    expect(screen.getByTestId("timeline-trimmer")).toBeInTheDocument();
    expect(screen.getByTestId("trimmer-duration-badge")).toHaveTextContent("Duration: 6.0s");
    expect(screen.getByTestId("trimmer-handle-start")).toHaveAttribute("aria-valuenow", "10");
    expect(screen.getByTestId("trimmer-handle-end")).toHaveAttribute("aria-valuenow", "16");
    expect(screen.getByTestId("trimmer-input-start")).toHaveValue("00:10.000");
    expect(screen.getByTestId("trimmer-input-end")).toHaveValue("00:16.000");
    expect(screen.getByTestId("trimmer-subtitle-preview")).toHaveTextContent(
      "Most founders fail because they ignore",
    );
    expect(screen.getByTestId("trimmer-subtitle-preview")).toHaveTextContent("distribution.");
  });

  it("seeks video element and fires onSeek in < 16ms when dragging handles, snapping to word boundaries by default", () => {
    const onSeek = vi.fn();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const videoEl = document.createElement("video");
    const videoRef = { current: videoEl };

    render(
      <TimelineTrimmer
        startSec={10.0}
        endSec={16.0}
        videoDurationSec={120}
        words={SAMPLE_WORDS}
        videoRef={videoRef}
        onSeek={onSeek}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );

    const track = screen.getByTestId("trimmer-track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const endHandle = screen.getByTestId("trimmer-handle-end");
    const t0 = performance.now();
    fireEvent.pointerDown(endHandle, { clientX: 600 });
    const seekLatencyMs = performance.now() - t0;
    expect(seekLatencyMs).toBeLessThan(16);
    expect(onSeek).toHaveBeenCalledWith(16.0);

    // Drag end handle near w12.end (20.4s): window is [0, 26], so 20.32s is at ratio 20.32 / 26 = 0.7815 -> 781.5px
    fireEvent.pointerMove(window, { clientX: 782, shiftKey: false });
    fireEvent.pointerUp(window, { clientX: 782, shiftKey: false });

    expect(onChange).toHaveBeenCalled();
    const lastChange = onChange.mock.calls.at(-1)?.[0];
    // Magnetic snap within ±0.2s snaps to w12.end = 20.4s
    expect(lastChange.endSec).toBeCloseTo(20.4, 2);
    expect(lastChange.snapped).toBe(true);
    expect(lastChange.bypassSnap).toBe(false);
    expect(videoEl.currentTime).toBeCloseTo(20.4, 2);
    expect(onCommit).toHaveBeenCalled();
  });

  it("bypasses magnetic snapping and quantizes to 1/30s frame boundaries when Shift is held during drag", () => {
    const onChange = vi.fn();
    render(
      <TimelineTrimmer
        startSec={10.0}
        endSec={16.0}
        videoDurationSec={120}
        words={SAMPLE_WORDS}
        onChange={onChange}
      />,
    );

    const track = screen.getByTestId("trimmer-track");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 64,
      right: 1000,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const endHandle = screen.getByTestId("trimmer-handle-end");
    fireEvent.pointerDown(endHandle, { clientX: 600, shiftKey: true });
    // Drag with shiftKey=true to ~20.32s (within 0.2s of 20.4s word end, but Shift bypasses word snap)
    fireEvent.pointerMove(window, { clientX: 781, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 781, shiftKey: true });

    const lastChange = onChange.mock.calls.at(-1)?.[0];
    expect(lastChange.bypassSnap).toBe(true);
    expect(lastChange.snapped).toBe(false);
    expect(lastChange.endSec).not.toBe(20.4);
  });

  it("supports text-linked trimming by clicking a word in the transcript strip to extend the clip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCommit = vi.fn();

    render(
      <TimelineTrimmer
        startSec={10.0}
        endSec={16.0}
        aiStartSec={10.0}
        aiEndSec={16.0}
        videoDurationSec={120}
        words={SAMPLE_WORDS}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );

    // Click "game." (index 12, end=20.4s) to extend the clip end boundary to include the punchline
    const gameWordBtn = screen.getByTestId("trimmer-word-12");
    expect(gameWordBtn).toHaveAttribute("data-word-included", "false");

    await user.click(gameWordBtn);

    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        startSec: 10.0,
        endSec: 20.4,
        isManualOverride: true,
      }),
    );
    expect(screen.getByTestId("trimmer-word-12")).toHaveAttribute("data-word-included", "true");
    expect(screen.getByTestId("trimmer-duration-badge")).toHaveTextContent("Duration: 10.4s");

    // Reset to AI Selection button appears and restores [10.0, 16.0]
    const resetBtn = screen.getByTestId("trimmer-reset-ai");
    await user.click(resetBtn);
    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startSec: 10.0,
        endSec: 16.0,
        isManualOverride: false,
      }),
    );
  });

  it("validates and applies direct millisecond timecode input and quick-nudge buttons", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <TimelineTrimmer
        startSec={10.0}
        endSec={16.0}
        videoDurationSec={120}
        words={SAMPLE_WORDS}
        onCommit={onCommit}
      />,
    );

    // Quick nudge +3.5s on end boundary: 16.0 + 3.5 = 19.5 -> within 0.2s of w11.end (19.6s) so snaps to 19.6s
    await user.click(screen.getByTestId("trimmer-nudge-end-plus-35"));
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        startSec: 10.0,
        endSec: 19.6,
        isManualOverride: true,
      }),
    );

    // Direct millisecond timecode entry
    const startInput = screen.getByTestId("trimmer-input-start");
    const endInput = screen.getByTestId("trimmer-input-end");
    await user.clear(startInput);
    await user.type(startInput, "00:08.200");
    await user.clear(endInput);
    await user.type(endInput, "00:20.400");
    await user.click(screen.getByTestId("trimmer-apply-timecodes"));

    expect(onCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startSec: 8.2,
        endSec: 20.4,
        isManualOverride: true,
      }),
    );
  });
});

