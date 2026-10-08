import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CloudImportProgress } from "./cloud-import-progress";

describe("<CloudImportProgress />", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("polls status and displays progress percentage and provider label", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "job-123",
        workspaceId: "ws-1",
        provider: "GOOGLE_DRIVE",
        fileId: "file-1",
        fileName: "interview.mp4",
        fileSizeBytes: "10000000",
        status: "STREAMING",
        progressPct: 45,
      }),
    });

    render(
      <CloudImportProgress
        jobId="job-123"
        fileName="interview.mp4"
        provider="GOOGLE_DRIVE"
      />,
    );

    expect(screen.getByText("interview.mp4")).toBeInTheDocument();
    expect(screen.getByText("(Google Drive)")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("45%")).toBeInTheDocument();
      expect(
        screen.getByText("Streaming directly to storage (zero-disk)…"),
      ).toBeInTheDocument();
    });
  });

  it("calls onCompleted when status reaches COMPLETED", async () => {
    const onCompleted = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "job-123",
        workspaceId: "ws-1",
        provider: "DROPBOX",
        fileId: "file-2",
        fileName: "podcast.mp3",
        fileSizeBytes: "5000000",
        status: "COMPLETED",
        progressPct: 100,
        s3Key: "raw/ws-1/file-2/audio.mp3",
      }),
    });

    render(
      <CloudImportProgress
        jobId="job-123"
        fileName="podcast.mp3"
        provider="DROPBOX"
        onCompleted={onCompleted}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
      expect(
        screen.getByText("Transfer complete! Ready to process."),
      ).toBeInTheDocument();
      expect(onCompleted).toHaveBeenCalled();
    });
  });
});

