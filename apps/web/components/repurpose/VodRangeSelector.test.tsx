import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VodRangeSelector } from "./VodRangeSelector";
import type { VodProbeResponse } from "@montaj/repurpose-contracts";

const MOCK_PROBE: VodProbeResponse = {
  platform: "TWITCH",
  vodId: "2091234567",
  title: "EPIC 4-HOUR SPEEDRUN & CHAT Q&A",
  channelName: "xQc",
  durationSec: 14400, // 4 hours
  thumbnailUrl: "https://example.com/thumb.jpg",
  isLive: false,
  chatVelocity: [
    { timestampSec: 0, mps: 1.2, topKeywords: ["GG"] },
    { timestampSec: 300, mps: 28.5, topKeywords: ["POG", "W", "CLIP THAT"] },
    { timestampSec: 600, mps: 2.1, topKeywords: [] },
  ],
  peaks: [
    {
      startSec: 270,
      endSec: 330,
      score: 95,
      topEmotes: ["POG", "W", "CLIP THAT"],
      reason: "Viral speedrun world record",
    },
    {
      startSec: 1200,
      endSec: 1260,
      score: 88,
      topEmotes: ["LMAO"],
      reason: "Unexpected glitch death",
    },
  ],
};

describe("VodRangeSelector component", () => {
  afterEach(cleanup);

  it("renders loading skeleton when isLoading is true", () => {
    render(<VodRangeSelector isLoading={true} />);
    expect(screen.getByTestId("vod-range-selector-skeleton")).toBeInTheDocument();
  });

  it("returns null when no probe is provided and not loading", () => {
    const { container } = render(<VodRangeSelector probe={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders VOD details, platform badge, and duration", () => {
    render(<VodRangeSelector probe={MOCK_PROBE} />);

    expect(screen.getByText("TWITCH")).toBeInTheDocument();
    expect(screen.getByText("EPIC 4-HOUR SPEEDRUN & CHAT Q&A")).toBeInTheDocument();
    expect(screen.getByText("xQc")).toBeInTheDocument();
    expect(screen.getByText("4:00:00")).toBeInTheDocument();
    expect(screen.getByTestId("chat-velocity-graph")).toBeInTheDocument();
  });

  it("renders peak badges and calls onSelectStartAt when clicked", () => {
    const onSelectStartAt = vi.fn();
    const onSelectRange = vi.fn();

    render(
      <VodRangeSelector
        probe={MOCK_PROBE}
        onSelectStartAt={onSelectStartAt}
        onSelectRange={onSelectRange}
      />,
    );

    const peakBadge0 = screen.getByTestId("peak-badge-0");
    expect(peakBadge0).toBeInTheDocument();

    fireEvent.click(peakBadge0);

    expect(onSelectStartAt).toHaveBeenCalledWith(270);
    expect(onSelectRange).toHaveBeenCalledWith({ startSec: 270, endSec: 330 });
  });

  it("handles Auto-Select Top 3 Peaks click", () => {
    const onSelectStartAt = vi.fn();
    const onSelectRange = vi.fn();

    render(
      <VodRangeSelector
        probe={MOCK_PROBE}
        onSelectStartAt={onSelectStartAt}
        onSelectRange={onSelectRange}
      />,
    );

    const autoSelectBtn = screen.getByTestId("auto-select-top-3-btn");
    fireEvent.click(autoSelectBtn);

    expect(onSelectStartAt).toHaveBeenCalledWith(270);
    expect(onSelectRange).toHaveBeenCalledWith({ startSec: 270, endSec: 1260 });
  });
});
