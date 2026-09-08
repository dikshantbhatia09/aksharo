import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LanguagePicker, rememberedLanguage, rememberLanguage } from "./language-picker";

import { renderWithProviders } from "@/test/harness";

describe("<LanguagePicker />", () => {
  it("shows a placeholder and no selection when it has no value", () => {
    renderWithProviders(<LanguagePicker value={undefined} onChange={vi.fn()} />);
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "");
    expect(screen.getByTestId("quick-pick-language-trigger")).toHaveTextContent(
      "Choose spoken language",
    );
    expect(screen.getByTestId("quick-pick-language-trigger")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows the chosen language's label on the trigger", () => {
    renderWithProviders(<LanguagePicker value="en" onChange={vi.fn()} />);
    expect(screen.getByTestId("quick-pick-language-trigger")).toHaveTextContent("English");
    expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "en");
  });

  it("opens a searchable, grouped list and reports a pick by its tag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<LanguagePicker value={undefined} onChange={onChange} />);

    await user.click(screen.getByTestId("quick-pick-language-trigger"));
    const popover = within(await screen.findByTestId("quick-pick-language-popover"));

    // "Desi & Regional" first (K02 acceptance criterion 1), the brief's own
    // example set, in order.
    expect(popover.getByText("Desi & Regional")).toBeInTheDocument();
    expect(popover.getByTestId("quick-pick-language-hi-Latn")).toBeInTheDocument();

    await user.click(popover.getByTestId("quick-pick-language-hi"));
    expect(onChange).toHaveBeenCalledWith("hi");
    // Selecting closes the popover and returns focus to the trigger.
    expect(screen.queryByTestId("quick-pick-language-popover")).not.toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-language-trigger")).toHaveFocus();
  });

  it("includes Nepali, Urdu and Pushto — the languages this WP adds", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LanguagePicker value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByTestId("quick-pick-language-trigger"));
    const popover = within(await screen.findByTestId("quick-pick-language-popover"));

    expect(popover.getByTestId("quick-pick-language-ne")).toBeInTheDocument();
    expect(popover.getByTestId("quick-pick-language-ur")).toBeInTheDocument();
    expect(popover.getByTestId("quick-pick-language-ps")).toBeInTheDocument();
  });

  it("narrows the list by typing — the brief's search view", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LanguagePicker value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByTestId("quick-pick-language-trigger"));
    const popover = within(await screen.findByTestId("quick-pick-language-popover"));

    await user.type(screen.getByTestId("quick-pick-language-search"), "urdu");

    expect(popover.getByTestId("quick-pick-language-ur")).toBeInTheDocument();
    expect(popover.queryByTestId("quick-pick-language-hi-Latn")).not.toBeInTheDocument();
  });

  it("closes on Escape without picking anything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<LanguagePicker value={undefined} onChange={onChange} />);
    await user.click(screen.getByTestId("quick-pick-language-trigger"));
    await screen.findByTestId("quick-pick-language-popover");

    await user.keyboard("{Escape}");

    expect(screen.queryByTestId("quick-pick-language-popover")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
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
