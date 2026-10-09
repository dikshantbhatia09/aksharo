import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  DURATION_BINS,
  DurationPicker,
  validateCustomDuration,
  type DurationBinSelection,
} from "./duration-picker";

function PickerHarness({
  initial = "BETWEEN_30_60",
  onChangeSpy,
}: {
  readonly initial?: DurationBinSelection;
  readonly onChangeSpy?: (bin: DurationBinSelection, bounds: { minSec: number; maxSec: number }) => void;
}): React.JSX.Element {
  const [bin, setBin] = React.useState<DurationBinSelection>(initial);
  const [customMin, setCustomMin] = React.useState(45);
  const [customMax, setCustomMax] = React.useState(75);

  return (
    <DurationPicker
      value={bin}
      customMinSec={customMin}
      customMaxSec={customMax}
      onCustomChange={(min, max) => {
        setCustomMin(min);
        setCustomMax(max);
      }}
      onChange={(nextBin, bounds) => {
        setBin(nextBin);
        onChangeSpy?.(nextBin, bounds);
      }}
    />
  );
}

describe("<DurationPicker />", () => {
  it("renders all preset duration chips and TikTok Monetization Eligible badges for >= 60s bins", () => {
    render(<PickerHarness />);

    expect(screen.getByTestId("duration-chip-UNDER_30")).toHaveTextContent("< 30s (Rapid Loops)");
    expect(screen.getByTestId("duration-chip-BETWEEN_30_60")).toHaveTextContent(
      "30s–60s (Shorts & Reels)",
    );
    expect(screen.getByTestId("duration-chip-BETWEEN_60_90")).toHaveTextContent(
      "60s–90s (TikTok Monetization)",
    );
    expect(screen.getByTestId("duration-chip-BETWEEN_90_180")).toHaveTextContent(
      "90s–3m (Deep Dives & LinkedIn)",
    );
    expect(screen.getByTestId("duration-chip-AUTO")).toHaveTextContent("AI Recommended");
    expect(screen.getByTestId("duration-chip-CUSTOM")).toHaveTextContent("Custom Range");

    // Badges on >= 60s presets
    expect(screen.getByTestId("tiktok-badge-BETWEEN_60_90")).toHaveTextContent(
      "TikTok Monetization Eligible",
    );
    expect(screen.getByTestId("tiktok-badge-BETWEEN_90_180")).toHaveTextContent(
      "TikTok Monetization Eligible",
    );
  });

  it("shows TikTok monetization warning when < 60s bin is selected and eligible banner when >= 60s is selected", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<PickerHarness initial="UNDER_30" onChangeSpy={spy} />);

    expect(screen.getByTestId("tiktok-monetization-warning")).toHaveTextContent(
      "Clips < 60s are not eligible for TikTok Rewards",
    );

    await user.click(screen.getByTestId("duration-chip-BETWEEN_60_90"));
    expect(spy).toHaveBeenCalledWith("BETWEEN_60_90", {
      minSec: DURATION_BINS.BETWEEN_60_90.minSec,
      maxSec: DURATION_BINS.BETWEEN_60_90.maxSec,
    });
    expect(screen.getByTestId("tiktok-monetization-eligible-banner")).toHaveTextContent(
      "TikTok Monetization Eligible",
    );
    expect(screen.queryByTestId("tiktok-monetization-warning")).toBeNull();
  });

  it("supports custom duration range input and validates 0 < min < max <= 300", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<PickerHarness initial="CUSTOM" onChangeSpy={spy} />);

    expect(screen.getByTestId("custom-duration-controls")).toBeInTheDocument();
    const minInput = screen.getByTestId("custom-duration-min");
    const maxInput = screen.getByTestId("custom-duration-max");

    expect(minInput).toHaveValue(45);
    expect(maxInput).toHaveValue(75);

    await user.clear(minInput);
    await user.type(minInput, "90");
    expect(screen.getByTestId("custom-duration-error")).toHaveTextContent(
      "Maximum duration must be strictly greater than minimum duration.",
    );

    expect(validateCustomDuration(45, 75)).toBeNull();
    expect(validateCustomDuration(0, 60)).toBe("Minimum duration must be greater than 0s.");
    expect(validateCustomDuration(30, 305)).toBe(
      "Maximum duration cannot exceed 300s (5 minutes).",
    );
    expect(validateCustomDuration(80, 60)).toBe(
      "Maximum duration must be strictly greater than minimum duration.",
    );
  });
});

