import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PlanTable } from "./plan-table";

import type { PlanView, SubscriptionView, WorkspaceBillingView } from "@/lib/billing/types";

import { renderWithProviders } from "@/test/harness";

const PLANS: PlanView[] = [
  {
    key: "free",
    name: "Free",
    prices: { INR: { month: 0, year: 0 }, USD: { month: 0, year: 0 } },
    creditsPerMonthTenths: 200,
    seatPrice: null,
    hasHalfyear: { INR: false, USD: false },
  },
  {
    key: "starter",
    name: "Starter",
    prices: { INR: { month: 29_900, year: 298_800 }, USD: { month: 800, year: 8_040 } },
    creditsPerMonthTenths: 1_500,
    seatPrice: null,
    hasHalfyear: { INR: false, USD: false },
  },
  {
    key: "creator",
    name: "Creator",
    prices: { INR: { month: 69_900, year: 698_400 }, USD: { month: 1_900, year: 18_960 } },
    creditsPerMonthTenths: 5_000,
    seatPrice: null,
    hasHalfyear: { INR: false, USD: false },
  },
  {
    key: "studio",
    name: "Studio",
    prices: {
      INR: { month: 199_900, year: 1_999_200, halfyear: 999_600 },
      USD: { month: 4_900, year: 49_200 },
    },
    creditsPerMonthTenths: 18_000,
    seatPrice: { INR: 39_900, USD: 700 },
    hasHalfyear: { INR: true, USD: false },
  },
  {
    key: "agency",
    name: "Agency",
    prices: { INR: { month: 119_900, year: 1_198_800 }, USD: { month: 2_900, year: 29_000 } },
    creditsPerMonthTenths: 9_000,
    seatPrice: { INR: 119_900, USD: 2_900 },
    hasHalfyear: { INR: false, USD: false },
  },
];

const WORKSPACE: WorkspaceBillingView = {
  id: "01JWORKSPACE",
  currency: "INR",
  billingCountry: "IN",
  billingCountryConfirmedAt: "2027-01-01T00:00:00.000Z",
  billingStateCode: "27",
  gstin: null,
  legalName: null,
  currencyLocked: false,
  role: "owner",
};

const NO_SUBSCRIPTION: SubscriptionView | null = null;

function baseRoutes(): Record<string, unknown> {
  return {
    "/billing/plans": PLANS,
    "/workspaces/01JWORKSPACE": WORKSPACE,
    "/billing/subscription": NO_SUBSCRIPTION,
  };
}

describe("<PlanTable />", () => {
  it("shows the monthly price by default, INR for an Indian workspace", async () => {
    renderWithProviders(<PlanTable />, { routes: baseRoutes() });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-creator-price")).toHaveTextContent("₹699");
    });
  });

  it("switches to the per-month-equivalent yearly price on the yearly toggle ('2 months free')", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanTable />, { routes: baseRoutes() });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-creator-price")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("plan-interval-year"));
    // 698_400 / 12 = 58_200 paise = ₹582.
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-creator-price")).toHaveTextContent("₹582");
    });
  });

  it("shows the Studio yearly half-yearly-debits explainer only on the yearly interval", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanTable />, { routes: baseRoutes() });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-studio-price")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("plan-card-studio-halfyear")).toBeNull();

    await user.click(screen.getByTestId("plan-interval-year"));
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-studio-halfyear")).toHaveTextContent("₹9,996");
    });
  });

  it("prices Agency by seat count: 1 seat is the base price, each extra seat adds the seat price", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanTable />, { routes: baseRoutes() });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-agency-price")).toHaveTextContent("₹1,199");
    });

    await user.click(screen.getByRole("button", { name: "More seats" }));
    await user.click(screen.getByRole("button", { name: "More seats" }));

    await waitFor(() => {
      // base 1,199 + 2 extra seats * 1,199 = 3,597.
      expect(screen.getByTestId("plan-card-agency-price")).toHaveTextContent("₹3,597");
    });
  });

  it("disables pay-once for a plan that does not offer it (Studio)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanTable />, { routes: baseRoutes() });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-studio-choose")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("pay-mode-once"));
    expect(screen.getByTestId("plan-card-studio-choose")).toBeDisabled();
    expect(screen.getByTestId("plan-card-creator-choose")).not.toBeDisabled();
  });

  it("marks the workspace's current plan and disables choosing it again", async () => {
    renderWithProviders(<PlanTable />, {
      routes: {
        ...baseRoutes(),
        "/billing/subscription": {
          id: "sub_1",
          planKey: "creator",
          status: "active",
          interval: "month",
          currency: "INR",
          listPriceMinor: 69_900,
          currentPeriodStart: "2027-01-01T00:00:00.000Z",
          currentPeriodEnd: "2027-02-01T00:00:00.000Z",
          renewalInitiateAt: null,
          graceUntil: null,
          cancelAtPeriodEnd: false,
          pausedUntil: null,
          seats: 1,
          mandateId: "mandate_1",
        } satisfies SubscriptionView,
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-creator-choose")).toBeDisabled();
    });
    expect(screen.getByTestId("plan-card-creator-choose")).toHaveTextContent("Current plan");
  });

  it("opens the checkout sheet for the chosen plan (gating: a click always leads somewhere, never a dead end)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanTable />, { routes: baseRoutes() });
    await waitFor(() => {
      expect(screen.getByTestId("plan-card-creator-choose")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("plan-card-creator-choose"));
    expect(await screen.findByTestId("checkout-sheet")).toBeInTheDocument();
  });
});
