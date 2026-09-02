import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { QuickPickRow } from "./quick-pick-row";

import type { UploadQuickPick } from "@/lib/upload/types";

import { renderWithProviders } from "@/test/harness";


describe("<QuickPickRow />", () => {
  it("shows the current language and aspect", () => {
    const value: UploadQuickPick = { language: "hi-Latn", aspect: "9:16" };
    renderWithProviders(<QuickPickRow value={value} onChange={vi.fn()} />, {
      routes: { "/styles": [] },
    });
    expect(screen.getByTestId("quick-pick-language")).toHaveTextContent("Hinglish (Roman)");
    expect(screen.getByTestId("quick-pick-aspect")).toHaveTextContent("9:16");
  });

  it("changes the language from the dropdown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: UploadQuickPick = { language: "hi-Latn", aspect: "9:16" };
    renderWithProviders(<QuickPickRow value={value} onChange={onChange} />, {
      routes: { "/styles": [] },
    });
    await user.click(screen.getByTestId("quick-pick-language"));
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
