import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  rememberedWritingScript,
  rememberWritingScript,
  WritingScriptPicker,
} from "./writing-script-picker";

describe("<WritingScriptPicker />", () => {
  it("shows a placeholder and no selection when it has no value", () => {
    render(<WritingScriptPicker value={undefined} onChange={vi.fn()} />);
    expect(screen.getByTestId("quickpick-writing-script")).toHaveAttribute("data-script", "");
    expect(screen.getByTestId("quick-pick-writing-script-trigger")).toHaveTextContent(
      "Choose writing script",
    );
  });

  it("shows the chosen script's label", () => {
    render(<WritingScriptPicker value="native" onChange={vi.fn()} />);
    expect(screen.getByTestId("quick-pick-writing-script-trigger")).toHaveTextContent("Native");
    expect(screen.getByTestId("quickpick-writing-script")).toHaveAttribute("data-script", "native");
  });

  it("offers Roman, Native and English, and reports a pick by its key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WritingScriptPicker value={undefined} onChange={onChange} />);

    await user.click(screen.getByTestId("quick-pick-writing-script-trigger"));
    expect(await screen.findByTestId("quick-pick-writing-script-roman")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-writing-script-native")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-writing-script-en")).toBeInTheDocument();

    await user.click(screen.getByTestId("quick-pick-writing-script-native"));
    expect(onChange).toHaveBeenCalledWith("native");
  });
});

describe("the browser's memory of the last writing-script pick", () => {
  it("round-trips a key", () => {
    rememberWritingScript("en");
    expect(rememberedWritingScript()).toBe("en");
    localStorage.clear();
    expect(rememberedWritingScript()).toBeUndefined();
  });

  it("treats unavailable storage as no memory rather than as an error", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(rememberedWritingScript()).toBeUndefined();
    expect(() => rememberWritingScript("roman")).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
