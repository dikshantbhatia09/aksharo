import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LanguagePicker, rememberedLanguage, rememberLanguage } from "./language-picker";

import { renderWithProviders } from "@/test/harness";

describe("<LanguagePicker />", () => {
  it("selects nothing at all when it has no value", () => {
    renderWithProviders(<LanguagePicker value={undefined} onChange={vi.fn()} />);
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute(
      "aria-label",
      "Spoken language",
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("marks the chosen segment as pressed", () => {
    renderWithProviders(<LanguagePicker value="en" onChange={vi.fn()} />);
    expect(screen.getByTestId("quick-pick-language-en")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("quick-pick-language-hi")).toHaveAttribute("aria-pressed", "false");
  });

  it("reports a segmented pick by its tag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<LanguagePicker value={undefined} onChange={onChange} />);
    await user.click(screen.getByTestId("quick-pick-language-hi"));
    expect(onChange).toHaveBeenCalledWith("hi");
  });

  it("offers the rest of the onboarding list under More…, and names the pick once made", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <LanguagePicker value={undefined} onChange={onChange} />,
    );
    expect(screen.getByTestId("quick-pick-language-more")).toHaveTextContent("More…");

    await user.click(screen.getByTestId("quick-pick-language-more"));
    await user.click(await screen.findByTestId("quick-pick-language-ta"));
    expect(onChange).toHaveBeenCalledWith("ta");

    rerender(<LanguagePicker value="ta" onChange={onChange} />);
    expect(screen.getByTestId("quick-pick-language-more")).toHaveTextContent("தமிழ்");
  });
});

describe("the browser's memory of the last pick", () => {
  it("round-trips a tag", () => {
    rememberLanguage("bn");
    expect(rememberedLanguage()).toBe("bn");
    localStorage.clear();
    expect(rememberedLanguage()).toBeUndefined();
  });

  it("treats unavailable storage as no memory rather than as an error", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(rememberedLanguage()).toBeUndefined();
    expect(() => rememberLanguage("hi")).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
