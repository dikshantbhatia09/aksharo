import { screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ShowNotesDrawer } from "./show-notes-drawer";
import { renderWithProviders } from "@/test/harness";

const MOCK_SHOW_NOTES = {
  id: "sn_123",
  projectId: "proj_123",
  summary: "A detailed summary of the podcast.",
  keyTakeaways: ["Point 1", "Point 2"],
  notableQuotes: [],
  youtubeChapters: [
    { startSec: 0, timestamp: "00:00", title: "Intro" },
    { startSec: 60, timestamp: "01:00", title: "Topic A" },
    { startSec: 150, timestamp: "02:30", title: "Conclusion" },
  ],
  status: "completed",
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};

describe("<ShowNotesDrawer />", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders empty state with generate button when no show notes exist", async () => {
    renderWithProviders(<ShowNotesDrawer projectId="proj_123" />, {
      routes: {
        "/projects/proj_123/show-notes": null,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("No Show Notes Yet")).toBeDefined();
      expect(screen.getByTestId("drawer-generate-btn")).toBeDefined();
    });
  });

  it("renders chapters and calls onSeek when chapter row is clicked", async () => {
    const onSeek = vi.fn();
    renderWithProviders(
      <ShowNotesDrawer projectId="proj_123" onSeek={onSeek} />,
      {
        routes: {
          "/projects/proj_123/show-notes": MOCK_SHOW_NOTES,
        },
      }
    );

    await waitFor(() => {
      expect(screen.getByText("Intro")).toBeDefined();
      expect(screen.getByText("Topic A")).toBeDefined();
      expect(screen.getByText("Conclusion")).toBeDefined();
    });

    const topicAButton = screen.getByText("Topic A").closest("button");
    expect(topicAButton).not.toBeNull();
    fireEvent.click(topicAButton!);

    expect(onSeek).toHaveBeenCalledWith(60_000);
  });

  it("copies full description and chapters from drawer", async () => {
    renderWithProviders(<ShowNotesDrawer projectId="proj_123" />, {
      routes: {
        "/projects/proj_123/show-notes": MOCK_SHOW_NOTES,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("drawer-copy-full-btn")).toBeDefined();
      expect(screen.getByTestId("drawer-copy-chapters-btn")).toBeDefined();
    });

    const copyChaptersBtn = screen.getByTestId("drawer-copy-chapters-btn");
    fireEvent.click(copyChaptersBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("00:00 - Intro\n01:00 - Topic A\n02:30 - Conclusion")
    );
  });
});

