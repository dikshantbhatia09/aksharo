import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApplyPanel } from "./ApplyPanel.js";

import type { ApplyPlanCounts } from "../../apply/runApply.js";
import type { ApplyMode } from "../../apply/types.js";

const counts: ApplyPlanCounts = {
  transcript: 12,
  mogrtCaptions: 12,
  alphaOverlay: 0,
  srtToBin: 1,
  cuts: 3,
  zooms: 2,
  audio: 1,
  sfxMusic: 2,
  titles: 1,
};

describe("ApplyPanel", () => {
  it("renders a checkbox with a dry-run count per mode", () => {
    render(
      <ApplyPanel
        counts={counts}
        selected={new Set()}
        onToggle={() => {}}
        onApply={() => {}}
        applying={false}
      />,
    );
    expect(screen.getByTestId("apply-mode-count-transcript")).toHaveTextContent("(12)");
    expect(screen.getByTestId("apply-mode-count-alphaOverlay")).toHaveTextContent("(0)");
  });

  it("calls onToggle when a checkbox is clicked", async () => {
    const onToggle = vi.fn();
    render(
      <ApplyPanel
        counts={counts}
        selected={new Set<ApplyMode>()}
        onToggle={onToggle}
        onApply={() => {}}
        applying={false}
      />,
    );
    await userEvent.click(screen.getByTestId("apply-mode-cuts"));
    expect(onToggle).toHaveBeenCalledWith("cuts");
  });

  it("disables Apply until at least one mode is selected", () => {
    render(
      <ApplyPanel
        counts={counts}
        selected={new Set()}
        onToggle={() => {}}
        onApply={() => {}}
        applying={false}
      />,
    );
    expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
  });

  it("enables Apply once a mode is selected and calls onApply", async () => {
    const onApply = vi.fn();
    render(
      <ApplyPanel
        counts={counts}
        selected={new Set<ApplyMode>(["cuts"])}
        onToggle={() => {}}
        onApply={onApply}
        applying={false}
      />,
    );
    const button = screen.getByRole("button", { name: /apply/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onApply).toHaveBeenCalled();
  });

  it("disables a mode with a message when disabledModes names it", () => {
    render(
      <ApplyPanel
        counts={counts}
        selected={new Set()}
        onToggle={() => {}}
        disabledModes={{ mogrtCaptions: "MOGRT self-test failed" }}
        onApply={() => {}}
        applying={false}
      />,
    );
    expect(screen.getByTestId("apply-mode-mogrtCaptions")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("MOGRT self-test failed");
  });

  it("disables every checkbox and shows Applying… while applying", () => {
    render(
      <ApplyPanel
        counts={counts}
        selected={new Set<ApplyMode>(["cuts"])}
        onToggle={() => {}}
        onApply={() => {}}
        applying={true}
      />,
    );
    expect(screen.getByTestId("apply-mode-cuts")).toBeDisabled();
    expect(screen.getByRole("button", { name: /applying/i })).toBeDisabled();
  });
});
