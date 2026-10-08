import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { YouTubePreviewCard } from "./YouTubePreviewCard";
import type { YouTubeProbeResponse } from "@montaj/repurpose-contracts";

describe("<YouTubePreviewCard />", () => {
  it("renders nothing when probe is null and not loading", () => {
    const { container } = render(<YouTubePreviewCard probe={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders loading skeleton when isLoading is true", () => {
    render(<YouTubePreviewCard isLoading={true} />);
    expect(screen.getByTestId("youtube-preview-skeleton")).toBeInTheDocument();
    expect(screen.getByText(/probing video details/i)).toBeInTheDocument();
  });

  it("renders error message when error is provided without probe", () => {
    render(<YouTubePreviewCard error="Failed to probe" />);
    expect(screen.getByTestId("youtube-preview-error")).toBeInTheDocument();
  });

  it("renders video details and native chapters when probe is successful", async () => {
    const user = userEvent.setup();
    const onSelectChapter = vi.fn();

    const probe: YouTubeProbeResponse = {
      videoId: "dQw4w9WgXcQ",
      title: "Sample Video on System Design",
      channelName: "Tech Explained",
      durationSec: 620,
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      isLiveStream: false,
      hasCaptions: true,
      nativeChapters: [
        { title: "Introduction", startSec: 0, endSec: 60 },
        { title: "Core Architecture", startSec: 60, endSec: 300 },
        { title: "Tradeoffs & Scaling", startSec: 300, endSec: 620 },
      ],
    };

    render(
      <YouTubePreviewCard
        probe={probe}
        onSelectChapter={onSelectChapter}
      />,
    );

    expect(screen.getByText("Sample Video on System Design")).toBeInTheDocument();
    expect(screen.getByText("Tech Explained")).toBeInTheDocument();
    expect(screen.getByText("10:20")).toBeInTheDocument();
    expect(screen.getByText(/3 creator chapters/i)).toBeInTheDocument();
    expect(screen.getByText(/captions available/i)).toBeInTheDocument();

    const chapterButton = screen.getByTestId("chapter-chip-1");
    expect(chapterButton).toHaveTextContent("Core Architecture");
    expect(chapterButton).toHaveTextContent("1:00");

    await user.click(chapterButton);
    expect(onSelectChapter).toHaveBeenCalledWith(60);
  });
});

