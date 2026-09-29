import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { EMPTY_START_FORM, SourceStartForm, type StartFormValue } from "./SourceStartForm";

/**
 * The brand kit switch on the start form (2026-10-02): offered only with
 * Autopilot on and a kit saved, on by default whenever it is offered.
 */
function Harness({
  brandKit,
  onValue,
}: {
  readonly brandKit: boolean;
  readonly onValue?: (value: StartFormValue) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>(EMPTY_START_FORM);
  onValue?.(value);
  return (
    <SourceStartForm
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      brandKit={brandKit}
    />
  );
}

describe("<SourceStartForm /> brand kit", () => {
  it("is not offered to a workspace without a kit", () => {
    render(<Harness brandKit={false} />);
    expect(screen.queryByTestId("brand-switch")).toBeNull();
  });

  it("is offered, and on, with a kit and Autopilot; it goes with Autopilot", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;
    render(
      <Harness
        brandKit
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    const toggle = screen.getByTestId("brand-switch");
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("brand-hint")).toHaveTextContent("Your logo, colours and end card");

    await user.click(toggle);
    expect(latest.useBrand).toBe(false);
    expect(screen.getByTestId("brand-hint")).toHaveTextContent("without your brand kit");

    // Only Autopilot applies a kit: with it off, there is nothing to offer.
    await user.click(screen.getByTestId("autopilot-switch"));
    expect(screen.queryByTestId("brand-switch")).toBeNull();
  });
});
