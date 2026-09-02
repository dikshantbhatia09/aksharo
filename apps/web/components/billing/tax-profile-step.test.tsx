import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TaxProfileStep } from "./tax-profile-step";

import { renderWithProviders } from "@/test/harness";

describe("<TaxProfileStep />", () => {
  it("auto-fills the State from a complete, valid GSTIN", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxProfileStep billing={undefined} isOwner onConfirmed={vi.fn()} />, {
      routes: {},
    });
    await user.type(screen.getByLabelText(/GSTIN/i), "27AAPFU0939F1ZV");
    expect(screen.getByTestId("tax-state-select")).toHaveValue("27");
  });

  it("flags a GSTIN with a wrong check digit rather than silently accepting it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxProfileStep billing={undefined} isOwner onConfirmed={vi.fn()} />, {
      routes: {},
    });
    // Same as the valid Maharashtra GSTIN but with the check digit flipped.
    await user.type(screen.getByLabelText(/GSTIN/i), "27AAPFU0939F1ZW");
    expect(await screen.findByText(/check digit does not match/i)).toBeInTheDocument();
  });

  it("flags a GSTIN whose State disagrees with the State selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxProfileStep billing={undefined} isOwner onConfirmed={vi.fn()} />, {
      routes: {},
    });
    // Select Karnataka (29) first, then a Maharashtra (27) GSTIN.
    await user.selectOptions(screen.getByTestId("tax-state-select"), "29");
    await user.type(screen.getByLabelText(/GSTIN/i), "27AAPFU0939F1ZV");
    expect(await screen.findByText(/does not match the State selected/i)).toBeInTheDocument();
  });

  it("shows the outside-India country picker and hides State/GSTIN", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxProfileStep billing={undefined} isOwner onConfirmed={vi.fn()} />, {
      routes: {},
    });
    await user.click(screen.getByTestId("tax-profile-outside-india"));
    expect(screen.getByTestId("tax-country-select")).toBeInTheDocument();
    expect(screen.queryByTestId("tax-state-select")).toBeNull();
  });
});
