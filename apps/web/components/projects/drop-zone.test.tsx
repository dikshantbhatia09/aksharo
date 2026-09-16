import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { toast } from "@montaj/ui";

import { DropZone } from "./drop-zone";

import { renderWithProviders } from "@/test/harness";

const ENTITLEMENT_ROUTE = {
  "/workspaces/01JWORKSPACE/entitlement": {
    workspaceId: "01JWORKSPACE",
    planKey: "creator",
    planName: "Creator",
    creditsPerMonthTenths: 5000,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: { maxFileBytes: 4 * 1024 * 1024 * 1024, maxDurationMs: 3 * 60 * 60 * 1000 },
    computedAt: "2026-09-02T00:00:00.000Z",
  },
};

function file(name = "clip.mp4", type = "video/mp4", bytes = 10): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("<DropZone />", () => {
  it("is a keyboard-reachable button that opens the file picker on Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DropZone onFiles={vi.fn()} />, { routes: {} });
    const button = screen.getByRole("button", { name: /drop video or audio here/i });

    const input = screen.getByTestId("drop-zone-input") as HTMLInputElement;
    // A real `<input type="file">` never opens from a scripted `.click()` in
    // jsdom (no OS picker to show), so this is what proves the button reached
    // it rather than trying to observe a picker that cannot exist here.
    const clickSpy = vi.spyOn(input, "click");
    button.focus();
    await user.keyboard("{Enter}");
    expect(clickSpy).toHaveBeenCalled();
  });

  it("does not nest the file input inside the button (axe: nested-interactive)", () => {
    renderWithProviders(<DropZone onFiles={vi.fn()} />, { routes: {} });
    const button = screen.getByRole("button", { name: /drop video or audio here/i });
    const input = screen.getByTestId("drop-zone-input");
    expect(button.contains(input)).toBe(false);
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).toHaveAttribute("aria-hidden", "true");
  });

  it("calls onFiles when a file is chosen through the input", () => {
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} />, { routes: {} });
    const input = screen.getByTestId("drop-zone-input") as HTMLInputElement;
    const dropped = file();
    fireEvent.change(input, { target: { files: [dropped] } });
    expect(onFiles).toHaveBeenCalledWith([dropped]);
  });

  it("calls onFiles for every file dropped, batching multiple at once", () => {
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} />, { routes: {} });
    const zone = screen.getByTestId("drop-zone");
    const files = [file("a.mp4"), file("b.wav")];
    fireEvent.drop(zone, { dataTransfer: { files } });
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("shows the plan's limits once the entitlement has loaded", async () => {
    renderWithProviders(<DropZone onFiles={vi.fn()} />, { routes: ENTITLEMENT_ROUTE });
    await waitFor(() => {
      expect(screen.getByTestId("drop-zone-limits")).toHaveTextContent("4 GB");
    });
    expect(screen.getByTestId("drop-zone-limits")).toHaveTextContent("Creator");
  });

  it("shows the transcription-time badge and the accepted formats", () => {
    // The badge belongs to the full-width variant; the canvas's panel omits it.
    renderWithProviders(<DropZone onFiles={vi.fn()} variant="block" />, { routes: {} });
    // F07-E1: the badge no longer quotes a number the pipeline cannot keep.
    const badge = screen.getByTestId("drop-zone-eta-badge");
    expect(badge).toHaveTextContent("Transcription usually takes a few minutes");
    expect(badge.textContent).not.toMatch(/[0-9]/);
    expect(screen.getByTestId("drop-zone-limits")).toHaveTextContent("MP4");
  });

  it("accepts every format the API accepts, not a subset of them", () => {
    renderWithProviders(<DropZone onFiles={vi.fn()} />, { routes: {} });
    const accept = screen.getByTestId("drop-zone-input").getAttribute("accept") ?? "";
    // These were the ones a hand-written subset used to leave out, which greyed
    // them out in the file dialog even though the API would have taken them.
    for (const extension of [".avi", ".m4v", ".mpeg", ".mpg", ".3gp", ".flac"]) {
      expect(accept).toContain(extension);
    }
    // MIME types too: Windows often reports no extension match for .mkv/.m4v.
    expect(accept).toContain("video/quicktime");
  });

  it("refuses a dropped file that is not media, and says so", async () => {
    const error = vi.spyOn(toast, "error");
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} />, { routes: {} });
    // A drop bypasses `accept` entirely, so this is the only guard on that path.
    fireEvent.drop(screen.getByTestId("drop-zone"), {
      dataTransfer: { files: [file("notes.pdf", "application/pdf")] },
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/is not a media file we can read/i),
      expect.anything(),
    );
  });

  it("still uploads the media in a mixed drop, refusing only the rest", async () => {
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} />, { routes: {} });
    const clip = file("a.mp4");
    fireEvent.drop(screen.getByTestId("drop-zone"), {
      dataTransfer: { files: [clip, file("notes.pdf", "application/pdf")] },
    });
    expect(onFiles).toHaveBeenCalledWith([clip]);
  });

  it("refuses a file over the plan cap before anything is hashed", async () => {
    const error = vi.spyOn(toast, "error");
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} />, { routes: ENTITLEMENT_ROUTE });
    await waitFor(() => {
      expect(screen.getByTestId("drop-zone-limits")).toHaveTextContent("4 GB");
    });
    // `UploadJob` hashes the whole file before the API can answer 413, so an
    // over-cap file must never enter the funnel in the first place.
    const huge = file("huge.mp4", "video/mp4", 1);
    Object.defineProperty(huge, "size", { value: 5 * 1024 * 1024 * 1024 });
    fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [huge] } });
    expect(onFiles).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/larger than your plan allows/i),
      expect.objectContaining({ description: expect.stringContaining("4 GB") }),
    );
  });

  it("does not block on size while the entitlement is still loading", () => {
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} />, { routes: {} });
    const huge = file("huge.mp4");
    Object.defineProperty(huge, "size", { value: 5 * 1024 * 1024 * 1024 });
    fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [huge] } });
    expect(onFiles).toHaveBeenCalledWith([huge]);
  });

  it("does nothing when disabled", async () => {
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} disabled />, { routes: {} });
    expect(screen.getByRole("button", { name: /drop video or audio here/i })).toBeDisabled();
    fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [file()] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
