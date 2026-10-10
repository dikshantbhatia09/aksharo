import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InlineWordColorPicker } from "./InlineWordColorPicker";

describe("InlineWordColorPicker", () => {
  it("renders default color swatches and title", () => {
    const onSelectColor = vi.fn();
    const onClose = vi.fn();

    render(
      <InlineWordColorPicker
        currentColor="#FFF000"
        onSelectColor={onSelectColor}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Highlight Color")).toBeInTheDocument();
    expect(screen.getByTestId("color-swatch-#FFF000")).toBeInTheDocument();
    expect(screen.getByTestId("color-swatch-#00FF66")).toBeInTheDocument();
    expect(screen.getByTestId("color-swatch-#00E5FF")).toBeInTheDocument();
  });

  it("selects a preset color and closes picker", () => {
    const onSelectColor = vi.fn();
    const onClose = vi.fn();

    render(
      <InlineWordColorPicker
        onSelectColor={onSelectColor}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("color-swatch-#00FF66"));
    expect(onSelectColor).toHaveBeenCalledWith("#00FF66");
    expect(onClose).toHaveBeenCalled();
  });

  it("resets highlight color when Reset is clicked", () => {
    const onSelectColor = vi.fn();
    const onClose = vi.fn();

    render(
      <InlineWordColorPicker
        currentColor="#FFF000"
        onSelectColor={onSelectColor}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("color-picker-reset"));
    expect(onSelectColor).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });

  it("applies valid custom hex code", () => {
    const onSelectColor = vi.fn();
    const onClose = vi.fn();

    render(
      <InlineWordColorPicker
        onSelectColor={onSelectColor}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId("color-picker-hex-input");
    fireEvent.change(input, { target: { value: "#123456" } });
    fireEvent.click(screen.getByTestId("color-picker-hex-apply"));

    expect(onSelectColor).toHaveBeenCalledWith("#123456");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape key press", () => {
    const onSelectColor = vi.fn();
    const onClose = vi.fn();

    render(
      <InlineWordColorPicker
        onSelectColor={onSelectColor}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

