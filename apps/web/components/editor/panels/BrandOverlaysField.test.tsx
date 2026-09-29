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
});
