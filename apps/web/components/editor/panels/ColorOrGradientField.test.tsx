import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Gradient } from "@montaj/caption-styles";

import { ColorOrGradientField, defaultGradient } from "./controls";

const GRADIENT: Gradient = {
  stops: [
    { offset: 0, color: "#ff2e63ff" },
    { offset: 1, color: "#3fa7d6ff" },
  ],
  angleDeg: 90,
};

describe("ColorOrGradientField (K08)", () => {
  it("renders a plain hex input in Solid mode and reports the Solid radio as checked", () => {
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value="#ffffffff"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("field-colors-text-mode-solid")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("field-colors-text-mode-gradient")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByTestId("field-colors-text-solid")).toHaveValue("#ffffff");
    expect(screen.queryByTestId("field-colors-text-stop-0-color")).toBeNull();
  });

  it("switching Solid -> Gradient seeds a schema-valid two-stop gradient from the current colour", async () => {
    const onChange = vi.fn();
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value="#112233ff"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("field-colors-text-mode-gradient"));
    expect(onChange).toHaveBeenCalledWith(defaultGradient("#112233ff"));
    const [seeded] = onChange.mock.calls[0] as [Gradient];
    expect(seeded.stops).toHaveLength(2);
    expect(seeded.angleDeg).toBe(90);
  });

  it("renders every stop and the angle slider in Gradient mode", () => {
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("field-colors-text-mode-gradient")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("field-colors-text-stop-0-color")).toHaveValue("#ff2e63");
    expect(screen.getByTestId("field-colors-text-stop-1-color")).toHaveValue("#3fa7d6");
    expect(screen.getByTestId("field-colors-text-angle")).toHaveValue("90");
  });

  it("switching Gradient -> Solid reports the first stop's colour, not the whole object", async () => {
    const onChange = vi.fn();
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("field-colors-text-mode-solid"));
    expect(onChange).toHaveBeenCalledWith("#ff2e63ff");
  });

  it("moving the angle slider writes angleDeg without touching the stops", () => {
    const onChange = vi.fn();
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("field-colors-text-angle"), { target: { value: "180" } });
    expect(onChange).toHaveBeenCalledWith({ ...GRADIENT, angleDeg: 180 });
  });

  it("editing one stop's colour rebuilds only that stop", () => {
    const onChange = vi.fn();
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("field-colors-text-stop-0-color"), {
      target: { value: "#000000" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...GRADIENT,
      stops: [{ offset: 0, color: "#000000" }, GRADIENT.stops[1]],
    });
  });

  it("adds a stop up to the six-stop cap and disables Add beyond it", async () => {
    const sixStops: Gradient = {
      angleDeg: 45,
      stops: Array.from({ length: 6 }, (_unused, index) => ({
        offset: index / 5,
        color: "#ffffffff",
      })),
    };
    const onChange = vi.fn();
    const { rerender } = render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("field-colors-text-add-stop"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [withThird] = onChange.mock.calls[0] as [Gradient];
    expect(withThird.stops).toHaveLength(3);

    rerender(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={sixStops}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("field-colors-text-add-stop")).toBeDisabled();
  });

  it("removes a stop down to the two-stop floor and disables Remove beyond it", async () => {
    const onChange = vi.fn();
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={onChange}
      />,
    );
    // Only two stops: both Remove buttons are already disabled.
    expect(screen.getByTestId("field-colors-text-stop-0-remove")).toBeDisabled();
    expect(screen.getByTestId("field-colors-text-stop-1-remove")).toBeDisabled();
    await userEvent.click(screen.getByTestId("field-colors-text-stop-1-remove"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Reset seeds a fresh two-stop gradient from the first stop's colour, discarding edits", async () => {
    const onChange = vi.fn();
    render(
      <ColorOrGradientField
        label="Text"
        idPrefix="field-colors-text"
        value={GRADIENT}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("field-colors-text-reset"));
    expect(onChange).toHaveBeenCalledWith(defaultGradient("#ff2e63ff"));
  });
});
