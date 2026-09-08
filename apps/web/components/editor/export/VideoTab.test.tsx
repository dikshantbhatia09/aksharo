import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { VideoTab, type VideoTabValue } from "./VideoTab";

/**
 * K07: the preset picker's two new Instagram entries, and the new
 * caption-opacity slider. `VideoTab` is a "dumb" controlled component (no
 * hooks, no network) — a plain `render`/`fireEvent` pair against the real
 * component is enough, no provider harness needed.
 */

const BASE_VALUE: VideoTabValue = {
  preset: "reels",
  script: "roman",
  dropFillers: false,
  captionOpacity: 1,
};

describe("<VideoTab />", () => {
  it("offers Instagram Story and Instagram Feed as selectable, correctly-dimensioned presets", () => {
    render(<VideoTab value={BASE_VALUE} onChange={vi.fn()} disabled={false} />);
    const select = screen.getByTestId("export-preset-select") as HTMLSelectElement;
    const optionLabels = [...select.options].map((option) => option.value);
    expect(optionLabels).toContain("instagram-story");
    expect(optionLabels).toContain("instagram-feed");

    const story = [...select.options].find((option) => option.value === "instagram-story");
    expect(story?.textContent).toMatch(/1080.*1920/);
    const feed = [...select.options].find((option) => option.value === "instagram-feed");
    expect(feed?.textContent).toMatch(/1080.*1350/);
  });

  it("keeps every existing preset option present and unchanged (no regression)", () => {
    render(<VideoTab value={BASE_VALUE} onChange={vi.fn()} disabled={false} />);
    const select = screen.getByTestId("export-preset-select") as HTMLSelectElement;
    const values = [...select.options].map((option) => option.value);
    expect(values).toEqual(expect.arrayContaining(["reels", "shorts", "youtube-4k", "square"]));
  });

  it("selecting Instagram Story calls onChange with the new preset value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VideoTab value={BASE_VALUE} onChange={onChange} disabled={false} />);
    await user.selectOptions(screen.getByTestId("export-preset-select"), "instagram-story");
    expect(onChange).toHaveBeenCalledWith({ ...BASE_VALUE, preset: "instagram-story" });
  });

  it("renders the caption-opacity slider defaulted to the value's own 0-1 fraction, shown as a percentage", () => {
    render(
      <VideoTab
        value={{ ...BASE_VALUE, captionOpacity: 0.6 }}
        onChange={vi.fn()}
        disabled={false}
      />,
    );
    const slider = screen.getByTestId("export-caption-opacity-slider") as HTMLInputElement;
    expect(slider.value).toBe("60");
    expect(screen.getByTestId("export-caption-opacity-value")).toHaveTextContent("60%");
  });

  it("defaults to 100% for a fresh export (matching the reference product's default)", () => {
    render(<VideoTab value={BASE_VALUE} onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId("export-caption-opacity-value")).toHaveTextContent("100%");
  });

  it("moving the slider calls onChange with the 0-1 fraction, not the raw 0-100 UI value", () => {
    const onChange = vi.fn();
    render(<VideoTab value={BASE_VALUE} onChange={onChange} disabled={false} />);
    const slider = screen.getByTestId("export-caption-opacity-slider");
    fireEvent.change(slider, { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith({ ...BASE_VALUE, captionOpacity: 0.45 });
  });

  it("disables the opacity slider and the preset select together", () => {
    render(<VideoTab value={BASE_VALUE} onChange={vi.fn()} disabled={true} />);
    expect(screen.getByTestId("export-preset-select")).toBeDisabled();
    expect(screen.getByTestId("export-caption-opacity-slider")).toBeDisabled();
  });
});
