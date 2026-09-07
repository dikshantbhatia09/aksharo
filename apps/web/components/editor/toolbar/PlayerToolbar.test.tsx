import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PlayerToolbar } from "./PlayerToolbar";

import { renderWithProviders } from "@/test/harness";

describe("<PlayerToolbar />", () => {
  it("shows the project's actual canvas geometry, not a recomputed guess", () => {
    renderWithProviders(
      <PlayerToolbar
        canvas={{ width: 1080, height: 1920, aspect: "9:16" }}
        safeZonesOn
        onSafeZonesChange={vi.fn()}
        projectId="01JPROJECT"
        mediaId="01JMEDIA"
      />,
    );
    expect(screen.getByTestId("resolution-indicator")).toHaveTextContent("1080×1920 · 9:16");
  });

  it("shows a different project's geometry correctly too (16:9)", () => {
    renderWithProviders(
      <PlayerToolbar
        canvas={{ width: 1920, height: 1080, aspect: "16:9" }}
        safeZonesOn={false}
        onSafeZonesChange={vi.fn()}
        projectId="01JPROJECT"
        mediaId="01JMEDIA"
      />,
    );
    expect(screen.getByTestId("resolution-indicator")).toHaveTextContent("1920×1080 · 16:9");
  });

  it("reflects the Safe Zone toggle's given state and calls back on change", async () => {
    const user = userEvent.setup();
    const onSafeZonesChange = vi.fn();
    renderWithProviders(
      <PlayerToolbar
        canvas={{ width: 1080, height: 1920, aspect: "9:16" }}
        safeZonesOn
        onSafeZonesChange={onSafeZonesChange}
        projectId="01JPROJECT"
        mediaId="01JMEDIA"
      />,
    );
    const toggle = screen.getByTestId("safe-zone-switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    expect(onSafeZonesChange).toHaveBeenCalledWith(false);
  });

  it("disables Replace media with a documented reason when the project has no media yet", () => {
    renderWithProviders(
      <PlayerToolbar
        canvas={{ width: 1080, height: 1920, aspect: "9:16" }}
        safeZonesOn
        onSafeZonesChange={vi.fn()}
        projectId="01JPROJECT"
        mediaId={undefined}
      />,
    );
    const button = screen.getByTestId("replace-media-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("no source media"));
  });
});
