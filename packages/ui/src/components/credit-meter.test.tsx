import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  CreditMeter,
  daysOfRunway,
  formatCredits,
  formatMinutes,
  formatResetDate,
} from "./credit-meter";
import { TooltipProvider } from "../primitives/tooltip";

function renderMeter(props: Partial<React.ComponentProps<typeof CreditMeter>> = {}) {
  return render(
    <TooltipProvider>
      <CreditMeter remainingTenths={2050} includedTenths={5000} {...props} />
    </TooltipProvider>,
  );
}

describe("formatCredits", () => {
  it("drops the decimal when the balance is whole", () => {
    expect(formatCredits(2000)).toBe("200");
  });

  it("keeps one decimal otherwise", () => {
    expect(formatCredits(2055)).toBe("205.5");
  });

  it("states the minute equivalence (08 §6)", () => {
    expect(formatMinutes(150)).toBe("15 min");
  });
});

describe("formatResetDate", () => {
  it("renders a short UTC date", () => {
    expect(formatResetDate("2026-05-03T00:00:00.000Z")).toBe("3 May");
  });

  it("returns undefined for a missing or unparseable date", () => {
    expect(formatResetDate(undefined)).toBeUndefined();
    expect(formatResetDate("not-a-date")).toBeUndefined();
  });
});

describe("daysOfRunway", () => {
  it("divides the balance by the trailing burn rate", () => {
    expect(daysOfRunway(1000, 100)).toBe(10);
  });

  it("is undefined without a burn rate", () => {
    expect(daysOfRunway(1000, undefined)).toBeUndefined();
    expect(daysOfRunway(1000, 0)).toBeUndefined();
  });
});

describe("<CreditMeter />", () => {
  it("shows credits left and the minute equivalence together", () => {
    renderMeter();
    expect(screen.getByTestId("credit-meter-balance")).toHaveTextContent("205 left");
    expect(screen.getByTestId("credit-meter-balance")).toHaveTextContent("205 min");
  });

  it("shows the reset date", () => {
    renderMeter({ resetsAt: "2026-09-30T00:00:00.000Z" });
    expect(screen.getByTestId("credit-meter-reset")).toHaveTextContent("Resets 30 Sep");
  });

  it("says so when nothing resets", () => {
    renderMeter();
    expect(screen.getByTestId("credit-meter-reset")).toHaveTextContent("No reset scheduled");
  });

  it("exposes the balance to assistive technology through the progress bar", () => {
    renderMeter();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "41");
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("205 of 500 credits left");
  });

  it("hides the streak badge unless the flag is on", () => {
    renderMeter({ streakDays: 6 });
    expect(screen.queryByTestId("credit-meter-streak")).toBeNull();
  });

  it("shows the streak badge behind the flag", () => {
    renderMeter({ streakDays: 6, showStreak: true });
    expect(screen.getByTestId("credit-meter-streak")).toHaveTextContent("6-day streak");
  });

  it("reveals the burn rate and the runway on hover", async () => {
    const user = userEvent.setup();
    renderMeter({ burnRateTenthsPerDay: 205 });
    await user.hover(screen.getByTestId("credit-meter").parentElement as HTMLElement);
    expect(await screen.findByText(/about 20.5 credits a day/i)).toBeInTheDocument();
    expect(screen.getByText(/lasts about 10 more days/i)).toBeInTheDocument();
  });

  it("calls onTopUp", async () => {
    const user = userEvent.setup();
    const onTopUp = vi.fn();
    renderMeter({ onTopUp });
    await user.click(screen.getByRole("button", { name: "Top up" }));
    expect(onTopUp).toHaveBeenCalledOnce();
  });
});
