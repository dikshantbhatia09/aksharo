import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { QuickPickRow } from "./quick-pick-row";

import type { UploadQuickPick } from "@/lib/upload/types";

import { renderWithProviders } from "@/test/harness";

/**
 * FIX-04: the language half of this row is now {@link LanguagePicker}, and the
 * fixtures below no longer start from a pre-selected `hi-Latn` — an unanswered
 * language is the row's honest opening state.
 */
describe("<QuickPickRow />", () => {
  it("shows nothing selected for the language until someone picks one", () => {
    const value: UploadQuickPick = { aspect: "9:16" };
    renderWithProviders(<QuickPickRow value={value} onChange={vi.fn()} />, {
      routes: { "/styles": [] },
    });
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "");
    expect(screen.getByTestId("quick-pick-language-hi-Latn")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("quick-pick-aspect")).toHaveTextContent("9:16");
  });

  it("shows the current language once it has one", () => {
    const value: UploadQuickPick = { language: "hi-Latn", aspect: "9:16" };
    renderWithProviders(<QuickPickRow value={value} onChange={vi.fn()} />, {
      routes: { "/styles": [] },
    });
    expect(screen.getByTestId("quick-pick-language-hi-Latn")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("changes the language from the picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: UploadQuickPick = { language: "hi-Latn", aspect: "9:16" };
    renderWithProviders(<QuickPickRow value={value} onChange={onChange} />, {
      routes: { "/styles": [] },
    });
    await user.click(screen.getByTestId("quick-pick-language-more"));
    await user.click(await screen.findByTestId("quick-pick-language-ta"));
    expect(onChange).toHaveBeenCalledWith({ ...value, language: "ta" });
  });

  it("changes the aspect from the dropdown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: UploadQuickPick = { language: "hi-Latn", aspect: "9:16" };
    renderWithProviders(<QuickPickRow value={value} onChange={onChange} />, {
      routes: { "/styles": [] },
    });
    await user.click(screen.getByTestId("quick-pick-aspect"));
    await user.click(await screen.findByTestId("quick-pick-aspect-16:9"));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ ...value, aspect: "16:9" });
    });
  });
});
