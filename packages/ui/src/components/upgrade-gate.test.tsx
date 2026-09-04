import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UpgradeGate } from "./upgrade-gate";

describe("<UpgradeGate />", () => {
  it("names the exact plan the entitlement error asked for", () => {
    render(
      <UpgradeGate
        requiredPlan="creator"
        feature="Exporting without a watermark"
        price="₹699/mo"
      />,
    );
    const gate = screen.getByTestId("upgrade-gate");
    expect(gate).toHaveAttribute("data-required-plan", "creator");
    expect(gate).toHaveTextContent("Exporting without a watermark is on Creator · ₹699/mo");
  });

  it("falls back to the raw plan key for a plan the label map does not know", () => {
    render(<UpgradeGate requiredPlan="enterprise-2027" feature="Bulk import" />);
    expect(screen.getByTestId("upgrade-gate")).toHaveTextContent(
      "Bulk import is on enterprise-2027",
    );
  });

  it("is never a dead end: the single click starts checkout (08 §5)", async () => {
    const user = userEvent.setup();
    const onUpgrade = vi.fn();
    render(<UpgradeGate requiredPlan="pro" feature="4K export" onUpgrade={onUpgrade} />);
    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(onUpgrade).toHaveBeenCalledOnce();
  });

  it("renders the checkout-sheet slot", () => {
    render(
      <UpgradeGate requiredPlan="pro" feature="4K export">
        <span data-testid="checkout-sheet-slot" />
      </UpgradeGate>,
    );
    expect(screen.getByTestId("checkout-sheet-slot")).toBeInTheDocument();
  });

  it("omits the button when no checkout is wired up yet", () => {
    render(<UpgradeGate requiredPlan="pro" feature="4K export" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // A build with no payment rail still gates the feature, but cannot offer to
  // sell the upgrade — it names who can lift the lock instead (F07-C3).
  it("lets the caller retitle the button instead of promising an upgrade", () => {
    render(
      <UpgradeGate
        requiredPlan="pro"
        feature="4K export"
        ctaLabel="Ask an admin about pro"
        onUpgrade={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Ask an admin about pro" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  });
});
