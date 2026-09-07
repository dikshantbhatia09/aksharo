import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PrepareMediaModal } from "./prepare-media-modal";

import type { UploadItemState } from "@/lib/upload/types";

import { renderWithProviders } from "@/test/harness";
import { routerMock } from "@/test/next-router";

function clip(): File {
  return new File(["x"], "clip.mp4", { type: "video/mp4" });
}

function item(overrides: Partial<UploadItemState> = {}): UploadItemState {
  return {
    id: "local-1",
    fileName: "clip.mp4",
    fileSize: 1_000_000,
    status: "uploading",
    progress: { uploadedBytes: 400_000, totalBytes: 1_000_000, completedParts: 1, totalParts: 3 },
    ...overrides,
  };
}

describe("<PrepareMediaModal /> — the language+script form", () => {
  it("renders nothing when closed", () => {
    renderWithProviders(
      <PrepareMediaModal
        open={false}
        onOpenChange={vi.fn()}
        file={undefined}
        item={undefined}
        initialLanguage={undefined}
        initialScript={undefined}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("prepare-media-modal")).not.toBeInTheDocument();
  });

  it("shows the file, and disables Generate Transcription without a language", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={undefined}
        initialLanguage={undefined}
        initialScript={undefined}
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByText("clip.mp4")).toBeInTheDocument();
    expect(modal.getByTestId("prepare-media-generate")).toBeDisabled();
  });

  it("pre-fills from the caller's remembered picks", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={undefined}
        initialLanguage="hi-Latn"
        initialScript="native"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByTestId("quick-pick-language-trigger")).toHaveTextContent("Hinglish (Roman)");
    expect(modal.getByTestId("quick-pick-writing-script-trigger")).toHaveTextContent("Native");
    expect(modal.getByTestId("prepare-media-generate")).toBeEnabled();
  });

  it("calls onGenerate with the chosen language, defaulting the script to roman", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={undefined}
        initialLanguage={undefined}
        initialScript={undefined}
        onGenerate={onGenerate}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));

    await user.click(modal.getByTestId("quick-pick-language-trigger"));
    await user.click(await modal.findByTestId("quick-pick-language-ta"));
    expect(modal.getByTestId("prepare-media-generate")).toBeEnabled();

    await user.click(modal.getByTestId("prepare-media-generate"));
    expect(onGenerate).toHaveBeenCalledWith("ta", "roman");
  });

  it("calls onGenerate with an explicitly chosen script", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={undefined}
        initialLanguage="en"
        initialScript={undefined}
        onGenerate={onGenerate}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));

    // The writing-script picker's options render through a Radix
    // `DropdownMenu` portal (document.body), outside the dialog's own DOM
    // subtree — unlike the language combobox's plain local popover — so the
    // option itself is found unscoped, even though its trigger is `modal`'s.
    await user.click(modal.getByTestId("quick-pick-writing-script-trigger"));
    await user.click(await screen.findByTestId("quick-pick-writing-script-en"));

    await user.click(modal.getByTestId("prepare-media-generate"));
    expect(onGenerate).toHaveBeenCalledWith("en", "en");
  });
});

describe("<PrepareMediaModal /> — the full-screen processing states (K02 scope item 3)", () => {
  it("shows an honest, non-numeric Uploading state before real progress exists", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={item({ status: "hashing" })}
        initialLanguage="en"
        initialScript="roman"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByTestId("processing-headline")).toHaveTextContent("Uploading your video");
    // `hashing` has no measured byte progress yet — the indeterminate bar
    // carries no `aria-valuenow`, unlike the real percentage below.
    expect(modal.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(modal.getByTestId("processing-tip")).toBeInTheDocument();
  });

  it("shows the real upload percentage once bytes are moving", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={item({
          status: "uploading",
          progress: {
            uploadedBytes: 250_000,
            totalBytes: 1_000_000,
            completedParts: 1,
            totalParts: 4,
          },
        })}
        initialLanguage="en"
        initialScript="roman"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("shows Analyzing for a processing (bytes-up, probe/proxy) row", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={item({ status: "processing", projectId: "01PROJECT" })}
        initialLanguage="en"
        initialScript="roman"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByTestId("processing-headline")).toHaveTextContent("Analyzing your media");
    expect(modal.getByTestId("prepare-media-open-project")).toBeInTheDocument();
  });

  it("shows Generating for a transcribing row, and opens the project on request", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={item({ status: "transcribing", projectId: "01PROJECT" })}
        initialLanguage="en"
        initialScript="roman"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByTestId("processing-headline")).toHaveTextContent("Generating your captions");

    await user.click(modal.getByTestId("prepare-media-open-project"));
    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/p/01PROJECT");
    });
  });

  it("shows the duplicate row with a link to the original project", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={item({ status: "duplicate", duplicateOfProjectId: "01ORIGINAL" })}
        initialLanguage="en"
        initialScript="roman"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByTestId("prepare-media-duplicate-open")).toHaveAttribute(
      "href",
      "/p/01ORIGINAL",
    );
  });

  it("never claims a status the row does not have — closing does not fabricate ready", async () => {
    renderWithProviders(
      <PrepareMediaModal
        open
        onOpenChange={vi.fn()}
        file={clip()}
        item={item({ status: "error", error: "The upload failed." })}
        initialLanguage="en"
        initialScript="roman"
        onGenerate={vi.fn()}
      />,
    );
    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(modal.getByTestId("processing-headline")).toHaveTextContent("The upload failed");
    expect(modal.getByText("The upload failed.")).toBeInTheDocument();
  });
});
