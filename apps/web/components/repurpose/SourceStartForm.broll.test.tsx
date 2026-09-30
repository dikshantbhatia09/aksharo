import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { brollOn, EMPTY_RUN_SETUP, runSetupRequest, runSetupValueOf } from "./RunSetupFields";
import { EMPTY_START_FORM, SourceStartForm, type StartFormValue } from "./SourceStartForm";

import type { BrollOffer } from "@/components/broll/use-broll-library";

/**
 * The B-roll switch on the start form (2026-10-05): offered only with
 * Autopilot on and something to fill a cutaway - on by default with a library
 * of pictures, off by default when only stock photos could.
 */
function Harness({
  broll,
  onValue,
}: {
  readonly broll?: BrollOffer;
  readonly onValue?: (value: StartFormValue) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>(EMPTY_START_FORM);
  onValue?.(value);
  return (
    <SourceStartForm
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      {...(broll === undefined ? {} : { broll })}
    />
  );
}

describe("<SourceStartForm /> B-roll", () => {
  it("is not offered when nothing could fill a cutaway", () => {
    render(<Harness />);
    expect(screen.queryByTestId("broll-switch")).toBeNull();
  });

  it("is on with a library, says it is a picture, and goes with Autopilot", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;
    render(
      <Harness
        broll="library"
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    const toggle = screen.getByTestId("broll-switch");
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("broll-hint")).toHaveTextContent(
      "a picture from your B-roll library",
    );

    await user.click(toggle);
    expect(latest.useBroll).toBe(false);
    expect(screen.getByTestId("broll-hint")).toHaveTextContent("without B-roll");

    await user.click(screen.getByTestId("autopilot-switch"));
    expect(screen.queryByTestId("broll-switch")).toBeNull();
  });

  it("is off by default with stock photos only, until the person turns it on", async () => {
    const user = userEvent.setup();
    render(<Harness broll="stock" />);
    const toggle = screen.getByTestId("broll-switch");
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("broll-hint")).toHaveTextContent("a stock photo");
  });
});

describe("runSetupRequest's B-roll", () => {
  it("sends broll only with Autopilot, something to fill it, and the switch on", () => {
    expect(runSetupRequest(EMPTY_RUN_SETUP, { broll: "library" })).toMatchObject({ broll: true });
    expect(runSetupRequest(EMPTY_RUN_SETUP, { broll: "stock" })).not.toHaveProperty("broll");
    expect(
      runSetupRequest({ ...EMPTY_RUN_SETUP, useBroll: true }, { broll: "stock" }),
    ).toMatchObject({ broll: true });
    expect(runSetupRequest({ ...EMPTY_RUN_SETUP, useBroll: true }, {})).not.toHaveProperty("broll");
    expect(
      runSetupRequest({ ...EMPTY_RUN_SETUP, autopilot: false }, { broll: "library" }),
    ).not.toHaveProperty("broll");
  });

  it("reads a saved setup's switch back as the person left it", () => {
    const saved = runSetupRequest(EMPTY_RUN_SETUP, { broll: "library" });
    expect(runSetupValueOf(saved).useBroll).toBe(true);
    const without = runSetupRequest({ ...EMPTY_RUN_SETUP, useBroll: false }, { broll: "library" });
    expect(runSetupValueOf(without).useBroll).toBe(false);
    expect(brollOn(runSetupValueOf(without), "library")).toBe(false);
  });
});
