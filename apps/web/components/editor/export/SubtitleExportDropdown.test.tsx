import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { EdgProjection } from "@montaj/render-core";

import { SubtitleExportDropdown } from "./SubtitleExportDropdown";
import * as subtitlesModule from "@/lib/export/subtitles";
import { renderWithProviders } from "@/test/harness";

function mockProjection(): EdgProjection {
  return {
    canvas: { width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
    segments: [
      { id: "s1", seq: "a0", startWordId: "0:0", endWordId: "0:1", startMs: 0, endMs: 1000 },
      { id: "s2", seq: "a1", startWordId: "0:2", endWordId: "0:3", startMs: 2000, endMs: 3000 },
    ],
    words: [
      { wid: "0:0", s: 0, e: 400, t: "hello" },
      { wid: "0:1", s: 400, e: 1000, t: "world" },
      { wid: "0:2", s: 2000, e: 2500, t: "second" },
      { wid: "0:3", s: 2500, e: 3000, t: "line" },
    ],
  };
}

describe("<SubtitleExportDropdown />", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the trigger button", () => {
    renderWithProviders(
      <SubtitleExportDropdown
        projectId="project-123"
        projection={mockProjection()}
      />,
    );

    expect(screen.getByTestId("subtitle-export-dropdown-trigger")).toBeInTheDocument();
  });

  it("opens menu and handles SRT download", async () => {
    const user = userEvent.setup();
    const downloadSpy = vi.spyOn(subtitlesModule, "downloadFile").mockImplementation(() => {});

    renderWithProviders(
      <SubtitleExportDropdown
        projectId="project-123"
        projection={mockProjection()}
      />,
    );

    await user.click(screen.getByTestId("subtitle-export-dropdown-trigger"));
    expect(screen.getByTestId("subtitle-export-dropdown-menu")).toBeInTheDocument();

    const srtOption = screen.getByTestId("subtitle-export-srt");
    await user.click(srtOption);

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    const [content, filename, mime] = downloadSpy.mock.calls[0]!;
    expect(filename).toBe("subtitles-project-123.srt");
    expect(mime).toBe("application/x-subrip");
    expect(content).toContain("00:00:00,000 --> 00:00:01,000");
    expect(content).toContain("hello world");
  });

  it("handles ASS export with karaoke timings and styling", async () => {
    const user = userEvent.setup();
    const downloadSpy = vi.spyOn(subtitlesModule, "downloadFile").mockImplementation(() => {});

    renderWithProviders(
      <SubtitleExportDropdown
        projectId="project-123"
        projection={mockProjection()}
      />,
    );

    await user.click(screen.getByTestId("subtitle-export-dropdown-trigger"));
    const assOption = screen.getByTestId("subtitle-export-ass");
    await user.click(assOption);

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    const [content, filename, mime] = downloadSpy.mock.calls[0]!;
    expect(filename).toBe("subtitles-project-123.ass");
    expect(mime).toBe("text/x-ssa");
    expect(content).toContain("[Script Info]");
    expect(content).toContain("Dialogue: 0,0:00:00.00,0:00:01.00");
  });

  it("handles JSON export for Remotion timeline", async () => {
    const user = userEvent.setup();
    const downloadSpy = vi.spyOn(subtitlesModule, "downloadFile").mockImplementation(() => {});

    renderWithProviders(
      <SubtitleExportDropdown
        projectId="project-123"
        projection={mockProjection()}
      />,
    );

    await user.click(screen.getByTestId("subtitle-export-dropdown-trigger"));
    const jsonOption = screen.getByTestId("subtitle-export-json");
    await user.click(jsonOption);

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    const [content, filename, mime] = downloadSpy.mock.calls[0]!;
    expect(filename).toBe("subtitles-project-123.json");
    expect(mime).toBe("application/json");
    const parsed = JSON.parse(content);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].text).toBe("hello world");
  });
});
