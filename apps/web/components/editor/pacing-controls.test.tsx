import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PacingControls } from "./pacing-controls";
import { renderWithProviders } from "@/test/harness";

describe("PacingControls (Silence & Dead-Air Trimming UI)", () => {
  it("renders silence threshold slider with default value", () => {
    renderWithProviders(<PacingControls thresholdSeconds={0.4} />);

    expect(screen.getByTestId("pacing-controls")).toBeInTheDocument();
    const slider = screen.getByTestId("silence-threshold-slider") as HTMLInputElement;
    expect(slider).toBeInTheDocument();
    expect(slider.value).toBe("0.4");
    expect(screen.getByTestId("threshold-value-display")).toHaveTextContent("0.40s");
  });

  it("fires onChangeThreshold when slider is moved", () => {
    const onChange = vi.fn();
    renderWithProviders(<PacingControls thresholdSeconds={0.4} onChangeThreshold={onChange} />);

    const slider = screen.getByTestId("silence-threshold-slider");
    fireEvent.change(slider, { target: { value: "0.6" } });

    expect(onChange).toHaveBeenCalledWith(0.6);
    expect(screen.getByTestId("threshold-value-display")).toHaveTextContent("0.60s");
  });

  it("selects quick preset threshold buttons [0.3s | 0.5s | 0.8s]", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<PacingControls thresholdSeconds={0.4} onChangeThreshold={onChange} />);

    await user.click(screen.getByTestId("preset-0-3"));
    expect(onChange).toHaveBeenCalledWith(0.3);

    await user.click(screen.getByTestId("preset-0-5"));
    expect(onChange).toHaveBeenCalledWith(0.5);

    await user.click(screen.getByTestId("preset-0-8"));
    expect(onChange).toHaveBeenCalledWith(0.8);
  });

  it("displays time saved badge when dead air has been trimmed", () => {
    const { rerender } = renderWithProviders(<PacingControls thresholdSeconds={0.4} timeSavedSeconds={0} />);
    expect(screen.queryByTestId("time-saved-badge")).toBeNull();

    rerender(<PacingControls thresholdSeconds={0.4} timeSavedSeconds={14.2} />);
    const badge = screen.getByTestId("time-saved-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Trimmed 14.2s of dead air!");
  });

  it("triggers onApply callback when Trim Dead Air button is clicked", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderWithProviders(
      <PacingControls thresholdSeconds={0.5} onApply={onApply} isApplying={false} />,
    );

    const button = screen.getByTestId("apply-pacing-button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("Trim Dead Air");

    await user.click(button);
    expect(onApply).toHaveBeenCalledWith(0.5);
  });
});
