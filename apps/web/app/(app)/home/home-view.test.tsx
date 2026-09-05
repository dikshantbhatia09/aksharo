import { screen, waitFor } from "@testing-library/react";
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

describe("<HomeView /> — the language is asked, never assumed (FIX-04)", () => {
  it("opens with no language selected", async () => {
    renderWithProviders(<HomeView />, { routes: ROUTES });
    await screen.findByTestId("quickpick-language");
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "");
  });

  // The cost-control invariant: the funnel that ends in a paid transcription
  // does not open on a guess.
  it("refuses a drop until one is chosen, and uploads nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeView />, { routes: ROUTES });
    await screen.findByTestId("quickpick-language");

    await user.upload(screen.getByTestId("drop-zone-input"), clip());

    expect(addFiles).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(
      "Choose the spoken language first",
      expect.objectContaining({
        description: "It decides which transcription lane your credits are spent on.",
      }),
    );
  });

  it("uploads once a language has been picked, and carries it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeView />, { routes: ROUTES });
    await user.click(await screen.findByTestId("quick-pick-language-en"));

    await user.upload(screen.getByTestId("drop-zone-input"), clip());

    await waitFor(() => {
      expect(addFiles).toHaveBeenCalledTimes(1);
    });
    expect(addFiles.mock.calls[0]?.[1]).toMatchObject({ language: "en" });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("remembers an explicit pick for the next visit", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<HomeView />, { routes: ROUTES });
    await user.click(await screen.findByTestId("quick-pick-language-en"));
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
    await screen.findByTestId("quickpick-language");
    // Give the adoption effect every chance to run before asserting it did not.
    await waitFor(() => {
      expect(screen.getByTestId("quick-pick-language-en")).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "en");
  });
});
