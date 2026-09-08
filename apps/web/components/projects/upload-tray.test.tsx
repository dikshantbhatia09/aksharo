import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UploadTray } from "./upload-tray";

import type { UploadItemState } from "@/lib/upload/types";

import { renderWithProviders } from "@/test/harness";

function item(overrides: Partial<UploadItemState> = {}): UploadItemState {
  return {
    id: "local-1",
    fileName: "clip.mp4",
    fileSize: 1000,
    status: "uploading",
    progress: { uploadedBytes: 500, totalBytes: 1000, completedParts: 1, totalParts: 2 },
    ...overrides,
  };
}

function noop(): void {
  // test double
}

describe("<UploadTray />", () => {
  it("renders nothing when there are no uploads", () => {
    const { container } = render(
      <UploadTray items={[]} pause={noop} resume={noop} cancel={noop} dismiss={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a Pause control while uploading and calls back with the item id", async () => {
    const user = userEvent.setup();
    const pause = vi.fn();
    render(
      <UploadTray items={[item()]} pause={pause} resume={noop} cancel={noop} dismiss={noop} />,
    );
    await user.click(screen.getByTestId("upload-pause"));
    expect(pause).toHaveBeenCalledWith("local-1");
  });

  it("shows Resume while paused", async () => {
    const user = userEvent.setup();
    const resume = vi.fn();
    render(
      <UploadTray
        items={[item({ status: "paused" })]}
        pause={noop}
        resume={resume}
        cancel={noop}
        dismiss={noop}
      />,
    );
    await user.click(screen.getByTestId("upload-resume"));
    expect(resume).toHaveBeenCalledWith("local-1");
  });

  it("offers Dismiss once ready, and Cancel while still working", () => {
    const { rerender } = render(
      <UploadTray
        items={[item({ status: "ready", projectId: "01JP" })]}
        pause={noop}
        resume={noop}
        cancel={noop}
        dismiss={noop}
      />,
    );
    expect(screen.getByTestId("upload-dismiss")).toBeInTheDocument();

    rerender(
      <UploadTray
        items={[item({ status: "creating-project" })]}
        pause={noop}
        resume={noop}
        cancel={noop}
        dismiss={noop}
      />,
    );
    expect(screen.getByTestId("upload-cancel")).toBeInTheDocument();
  });

  it("shows the duplicate message with a link to the original project", () => {
    render(
      <UploadTray
        items={[item({ status: "duplicate", duplicateOfProjectId: "01JORIGINAL" })]}
        pause={noop}
        resume={noop}
        cancel={noop}
        dismiss={noop}
      />,
    );
    expect(screen.getByText("Already in your workspace.")).toBeInTheDocument();
    expect(screen.getByTestId("duplicate-open-original")).toHaveAttribute("href", "/p/01JORIGINAL");
  });

  it("shows the error and offers a retry", () => {
    render(
      <UploadTray
        items={[item({ status: "error", error: "The upload failed." })]}
        pause={noop}
        resume={noop}
        cancel={noop}
        dismiss={noop}
      />,
    );
    expect(screen.getByText("The upload failed.")).toBeInTheDocument();
  });

  // K02: a server-owned row (bytes up, the pipeline now owns the rest) gets
  // the same rotating "Did you know?" the full-screen states show — a
  // presentational addition over the real, already-polled pipeline status,
  // never a second source of truth for it.
  it("shows a rotating tip once a row is server-owned", async () => {
    renderWithProviders(
      <UploadTray
        items={[item({ status: "processing", projectId: "01PROJECT" })]}
        pause={noop}
        resume={noop}
        cancel={noop}
        dismiss={noop}
      />,
      { routes: { "/projects/01PROJECT/transcription-state": { status: "processing_media" } } },
    );
    await waitFor(() => {
      expect(screen.getByTestId("processing-tip")).toBeInTheDocument();
    });
  });
});
