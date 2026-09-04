import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

function file(name = "clip.mp4"): File {
  return new File([new Uint8Array(10)], name, { type: "video/mp4" });
}

describe("<DropZone />", () => {
  it("is a keyboard-reachable button that opens the file picker on Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DropZone onFiles={vi.fn()} />, { routes: {} });
    const button = screen.getByRole("button", { name: /drop videos or audio here/i });

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
    const button = screen.getByRole("button", { name: /drop videos or audio here/i });
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
    renderWithProviders(<DropZone onFiles={vi.fn()} />, { routes: {} });
    // F07-E1: the badge no longer quotes a number the pipeline cannot keep.
    const badge = screen.getByTestId("drop-zone-eta-badge");
    expect(badge).toHaveTextContent("Transcription usually takes a few minutes");
    expect(badge.textContent).not.toMatch(/[0-9]/);
    expect(screen.getByTestId("drop-zone-limits")).toHaveTextContent("MP4");
  });

  it("does nothing when disabled", async () => {
    const onFiles = vi.fn();
    renderWithProviders(<DropZone onFiles={onFiles} disabled />, { routes: {} });
    expect(screen.getByRole("button", { name: /drop videos or audio here/i })).toBeDisabled();
    fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [file()] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
