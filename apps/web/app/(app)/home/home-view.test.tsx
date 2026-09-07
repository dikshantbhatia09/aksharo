import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as UiModule from "@montaj/ui";

import { HomeView } from "./home-view";

import { renderWithProviders } from "@/test/harness";

const addFiles = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("@/lib/upload/use-upload-queue", () => ({
  useUploadQueue: () => ({
    items: [],
    addFiles,
    addFilesToProjects: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@montaj/ui", async () => {
  const actual = await vi.importActual<typeof UiModule>("@montaj/ui");
  return { ...actual, toast: { ...actual.toast, info: toastInfo } };
});

const ME = {
  id: "01JUSER",
  email: "creator@aksharo.ai",
  name: "Asha",
  workspaceId: "01JWORKSPACE",
  role: "owner",
};

const ROUTES: Record<string, unknown> = {
  "/me": ME,
  "/projects": { items: [], nextCursor: null },
  "/styles": [],
};

function clip(): File {
  return new File(["x"], "clip.mp4", { type: "video/mp4" });
}

beforeEach(() => {
  localStorage.clear();
  addFiles.mockReset();
  toastInfo.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

/** Opens the (background, always-visible) quick-pick row's language combobox and picks `tag`. */
async function pickQuickLanguage(
  user: ReturnType<typeof userEvent.setup>,
  tag: string,
): Promise<void> {
  await user.click(screen.getByTestId("quick-pick-language-trigger"));
  await user.click(await screen.findByTestId(`quick-pick-language-${tag}`));
}

describe("<HomeView /> — the language is asked, never assumed (FIX-04, modal flow since K02)", () => {
  it("opens with no language selected", async () => {
    renderWithProviders(<HomeView />, { routes: ROUTES });
    await screen.findByTestId("quickpick-language");
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "");
  });

  // K02: a single file no longer uploads (or refuses) on the spot — it opens
  // "Prepare Your Media", and THAT dialog is where an unanswered language now
  // blocks the upload (`Generate Transcription` stays disabled). The
  // cost-control invariant (no transcription credits spent without an
  // explicit language) is unchanged; only where it is enforced moved.
  it("opens Prepare Your Media on a drop, and uploads nothing until Generate Transcription is used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeView />, { routes: ROUTES });
    await screen.findByTestId("quickpick-language");

    await user.upload(screen.getByTestId("drop-zone-input"), clip());

    const modal = within(await screen.findByTestId("prepare-media-modal"));
    expect(addFiles).not.toHaveBeenCalled();
    expect(modal.getByTestId("prepare-media-generate")).toBeDisabled();
  });

  it("uploads once a language has been picked in the modal, and carries it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeView />, { routes: ROUTES });

    await user.upload(screen.getByTestId("drop-zone-input"), clip());
    const modal = within(await screen.findByTestId("prepare-media-modal"));

    await user.click(modal.getByTestId("quick-pick-language-trigger"));
    await user.click(await modal.findByTestId("quick-pick-language-en"));
    expect(modal.getByTestId("prepare-media-generate")).toBeEnabled();

    await user.click(modal.getByTestId("prepare-media-generate"));

    await waitFor(() => {
      expect(addFiles).toHaveBeenCalledTimes(1);
    });
    expect(addFiles.mock.calls[0]?.[0]).toHaveLength(1);
    expect(addFiles.mock.calls[0]?.[1]).toMatchObject({ language: "en" });
    expect(toastInfo).not.toHaveBeenCalled();
    // The pick is remembered exactly as the pre-K02 pre-drop pick was.
    expect(localStorage.getItem("montaj.quickpick.language")).toBe("en");
  });

  // The batch ("2+ files at once") path is untouched by K02 — it still gates
  // on the background row's language before opening the "apply to all" sheet,
  // since `BatchApplyToAllSheet` is outside this WP's file boundary.
  it("still refuses a batch drop until the background row has a language", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeView />, { routes: ROUTES });
    await screen.findByTestId("quickpick-language");

    await user.upload(screen.getByTestId("drop-zone-input"), [clip(), clip()]);

    expect(addFiles).not.toHaveBeenCalled();
    expect(screen.queryByTestId("prepare-media-modal")).not.toBeInTheDocument();
    expect(toastInfo).toHaveBeenCalledWith(
      "Choose the spoken language first",
      expect.objectContaining({
        description: "It decides which transcription lane your credits are spent on.",
      }),
    );
  });

  it("remembers an explicit pick made on the background row for the next visit", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<HomeView />, { routes: ROUTES });
    await pickQuickLanguage(user, "en");
    expect(localStorage.getItem("montaj.quickpick.language")).toBe("en");
    first.unmount();

    renderWithProviders(<HomeView />, { routes: ROUTES });
    await waitFor(() => {
      expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "en");
    });
  });

  // Addendum-3 precedence, both directions.
  it("adopts the onboarding language into an empty pick", async () => {
    renderWithProviders(<HomeView />, {
      routes: { ...ROUTES, "/me": { ...ME, onboarding: { languages: ["ta"] } } },
    });
    await waitFor(() => {
      expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "ta");
    });
  });

  it("never lets the onboarding default overwrite a remembered pick", async () => {
    localStorage.setItem("montaj.quickpick.language", "en");
    renderWithProviders(<HomeView />, {
      routes: { ...ROUTES, "/me": { ...ME, onboarding: { languages: ["ta"] } } },
    });
    // Give the adoption effect every chance to run before asserting it did not.
    await waitFor(() => {
      expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "en");
    });
    expect(screen.getByTestId("quick-pick-language-trigger")).toHaveTextContent("English");
  });
});
