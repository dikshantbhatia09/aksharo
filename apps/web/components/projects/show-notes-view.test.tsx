import { screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ShowNotesView } from "./show-notes-view";
import { renderWithProviders } from "@/test/harness";

const PROJECT_ROUTE = {
  "/projects/proj_123": {
    id: "proj_123",
    title: "AI Deep Dive Episode 42",
    workspaceId: "01JWORKSPACE",
    status: "active",
  },
};

const MOCK_SHOW_NOTES = {
  id: "sn_123",
  projectId: "proj_123",
  summary: "This is a detailed executive summary about AI and podcasting workflows.",
  keyTakeaways: [
    "AI automates repetitive transcription tasks",
    "Timestamped chapters boost YouTube audience engagement",
    "Multi-platform repurposing expands reach",
  ],
  notableQuotes: [
    {
      quote: "Content creation is evolving at lightning speed.",
      speaker: "Host",
      timestampSec: 15.5,
    },
  ],
  youtubeChapters: [
    { startSec: 0, timestamp: "00:00", title: "Introduction & Context" },
    { startSec: 45, timestamp: "00:45", title: "Core Architecture" },
    { startSec: 120, timestamp: "02:00", title: "Automated Repurposing" },
  ],
  status: "completed",
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};

describe("<ShowNotesView />", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders empty state when no show notes exist", async () => {
    renderWithProviders(<ShowNotesView projectId="proj_123" />, {
      routes: {
        ...PROJECT_ROUTE,
        "/projects/proj_123/show-notes": null,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("No Show Notes Generated Yet")).toBeDefined();
      expect(screen.getByTestId("generate-show-notes-primary-btn")).toBeDefined();
    });
  });

  it("renders populated show notes with chapters, summary, and takeaways", async () => {
    renderWithProviders(<ShowNotesView projectId="proj_123" />, {
      routes: {
        ...PROJECT_ROUTE,
        "/projects/proj_123/show-notes": MOCK_SHOW_NOTES,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("This is a detailed executive summary about AI and podcasting workflows.")).toBeDefined();
      expect(screen.getByText("AI automates repetitive transcription tasks")).toBeDefined();
      expect(screen.getByText(/Content creation is evolving/)).toBeDefined();
      expect(screen.getByText("Introduction & Context")).toBeDefined();
      expect(screen.getByText("Core Architecture")).toBeDefined();
      expect(screen.getByText("Automated Repurposing")).toBeDefined();
    });
  });

  it("handles copy chapters to clipboard", async () => {
    renderWithProviders(<ShowNotesView projectId="proj_123" />, {
      routes: {
        ...PROJECT_ROUTE,
        "/projects/proj_123/show-notes": MOCK_SHOW_NOTES,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("copy-youtube-chapters-btn")).toBeDefined();
    });

    const copyBtn = screen.getByTestId("copy-youtube-chapters-btn");
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("00:00 - Introduction & Context\n00:45 - Core Architecture\n02:00 - Automated Repurposing")
    );
  });

  it("handles copy full description to clipboard", async () => {
    renderWithProviders(<ShowNotesView projectId="proj_123" />, {
      routes: {
        ...PROJECT_ROUTE,
        "/projects/proj_123/show-notes": MOCK_SHOW_NOTES,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("copy-full-description-btn")).toBeDefined();
    });

    const copyBtn = screen.getByTestId("copy-full-description-btn");
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("TIMESTAMPS & CHAPTERS")
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("KEY TAKEAWAYS")
    );
  });
});
