import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { AgeConsentStep, EMPTY_AGE_CONSENT } from "./age-consent-step";

import type { AgeConsentValue } from "./age-consent-step";

import { renderWithProviders } from "@/test/harness";

function Harness({
  onSubmit,
  onBlocked,
  initial = EMPTY_AGE_CONSENT,
}: {
  onSubmit: () => void;
  onBlocked: (jurisdiction: "IN" | "EU" | "OTHER") => void;
  initial?: AgeConsentValue;
}): React.JSX.Element {
  const [value, setValue] = React.useState(initial);
  return (
    <AgeConsentStep value={value} onChange={setValue} onSubmit={onSubmit} onBlocked={onBlocked} />
  );
}

describe("<AgeConsentStep /> — onboarding step 0 (D60)", () => {
  it("starts with both consents off and nothing pre-ticked", () => {
    renderWithProviders(<Harness onSubmit={vi.fn()} onBlocked={vi.fn()} />);
    expect(screen.getByTestId("consent-analytics")).not.toBeChecked();
    expect(screen.getByTestId("consent-memory")).not.toBeChecked();
  });

  it("defaults the jurisdiction to India and lets it be changed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onSubmit={vi.fn()} onBlocked={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "India" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /European Union/ }));
    expect(screen.getByRole("radio", { name: /European Union/ })).toBeChecked();
  });

  it("describes each consent, so the switch is not the whole ask", () => {
    renderWithProviders(<Harness onSubmit={vi.fn()} onBlocked={vi.fn()} />);
    expect(screen.getByTestId("consent-analytics")).toHaveAccessibleDescription(/off by default/i);
    expect(screen.getByTestId("consent-memory")).toHaveAccessibleDescription(
      /never train AI models on your footage/i,
    );
  });

  it("does not submit an unparseable date", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(<Harness onSubmit={onSubmit} onBlocked={vi.fn()} />);
    await user.click(screen.getByTestId("age-consent-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits for an adult, carrying the toggles the user set", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onBlocked = vi.fn();
    renderWithProviders(
      <Harness
        onSubmit={onSubmit}
        onBlocked={onBlocked}
        initial={{ ...EMPTY_AGE_CONSENT, dateOfBirth: "1995-04-12" }}
      />,
    );
    await user.click(screen.getByTestId("consent-analytics"));
    expect(screen.getByTestId("consent-analytics")).toBeChecked();

    await user.click(screen.getByTestId("age-consent-submit"));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("blocks an under-18 in India before the request is made", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onBlocked = vi.fn();
    renderWithProviders(
      <Harness
        onSubmit={onSubmit}
        onBlocked={onBlocked}
        initial={{ ...EMPTY_AGE_CONSENT, dateOfBirth: "2012-01-01", jurisdiction: "IN" }}
      />,
    );
    await user.click(screen.getByTestId("age-consent-submit"));
    expect(onBlocked).toHaveBeenCalledWith("IN");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("lets the same 16-year-old through in the EU", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onBlocked = vi.fn();
    renderWithProviders(
      <Harness
        onSubmit={onSubmit}
        onBlocked={onBlocked}
        initial={{ ...EMPTY_AGE_CONSENT, dateOfBirth: "2009-01-01", jurisdiction: "EU" }}
      />,
    );
    await user.click(screen.getByTestId("age-consent-submit"));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("links the privacy notice from the step itself", () => {
    renderWithProviders(<Harness onSubmit={vi.fn()} onBlocked={vi.fn()} />);
    expect(screen.getByRole("link", { name: "privacy notice" })).toHaveAttribute(
      "href",
      "/legal/privacy",
    );
  });
});
