import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BrandOverlaysField, type BrandOverlaysFieldProps } from "./BrandOverlaysField";

function props(overrides: Partial<BrandOverlaysFieldProps> = {}): BrandOverlaysFieldProps {
  return {
    logoOn: false,
    logoAvailable: true,
    endCardOn: false,
    endCardAvailable: true,
    onLogo: vi.fn(),
    onEndCard: vi.fn(),
    ...overrides,
  };
}

describe("<BrandOverlaysField />", () => {
  it("turns the logo and the end card on and off", async () => {
    const user = userEvent.setup();
    const onLogo = vi.fn();
    const onEndCard = vi.fn();
    const view = render(<BrandOverlaysField {...props({ onLogo, onEndCard, endCardOn: true })} />);
    await user.click(screen.getByTestId("brand-overlay-logo"));
    expect(onLogo).toHaveBeenCalledWith(true);
    await user.click(screen.getByTestId("brand-overlay-end-card"));
    expect(onEndCard).toHaveBeenCalledWith(false);
    // Everything to hand: no pointer to settings.
    expect(view.queryByTestId("brand-overlays-settings")).toBeNull();
  });

  it("cannot put on what the kit does not have, but can always take off what the clip has", () => {
    render(
      <BrandOverlaysField
        {...props({ logoAvailable: false, endCardAvailable: false, endCardOn: true })}
      />,
    );
    expect(screen.getByTestId("brand-overlay-logo")).toBeDisabled();
    expect(screen.getByTestId("brand-overlay-end-card")).toBeEnabled();
    expect(screen.getByText("Add a logo to your brand kit first.")).toBeInTheDocument();
    expect(screen.getByTestId("brand-overlays-settings")).toHaveAttribute(
      "href",
      "/settings/brand-kit",
    );
  });

  it("takes the kit's music off the clip and puts it back (2026-10-04)", async () => {
    const user = userEvent.setup();
    const onMusic = vi.fn();
    const view = render(
      <BrandOverlaysField {...props({ music: { on: true, title: "Morning theme", onMusic } })} />,
    );
    expect(
      view.getByText("“Morning theme” under the speech, quieter while anyone talks."),
    ).toBeInTheDocument();
    await user.click(view.getByTestId("brand-overlay-music"));
    expect(onMusic).toHaveBeenCalledWith(false);

    view.rerender(
      <BrandOverlaysField {...props({ music: { on: false, title: null, onMusic } })} />,
    );
    expect(view.getByTestId("brand-overlay-music")).not.toBeChecked();
    await user.click(view.getByTestId("brand-overlay-music"));
    expect(onMusic).toHaveBeenLastCalledWith(true);
  });

  it("has no music switch for a clip that never had music", () => {
    render(<BrandOverlaysField {...props()} />);
    expect(screen.queryByTestId("brand-overlay-music")).toBeNull();
  });
});
