import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StreakView } from "@montaj/api-client";

import { OverviewPanel } from "./overview-panel";

import type { CreditsSummary, SubscriptionView } from "@/lib/billing/types";

import * as razorpay from "@/lib/billing/razorpay";
import { renderWithProviders } from "@/test/harness";

vi.mock("@/lib/billing/razorpay", () => ({
  openRazorpayCheckout: vi.fn(),
  loadRazorpayCheckout: vi.fn(),
}));

// `restoreMocks: true` (packages/config/vitest.base.mjs) clears every mock's
// implementation before each test, so this is re-armed here rather than once
// at module scope.
beforeEach(() => {
  vi.mocked(razorpay.openRazorpayCheckout).mockResolvedValue({ status: "dismissed" });
  vi.mocked(razorpay.loadRazorpayCheckout).mockResolvedValue(null);
});

const ACTIVE_SUBSCRIPTION: SubscriptionView = {
  id: "sub_1",
  planKey: "creator",
  status: "active",
  interval: "month",
  currency: "INR",
  listPriceMinor: 69_900,
  currentPeriodStart: "2027-01-01T00:00:00.000Z",
  currentPeriodEnd: "2027-02-01T00:00:00.000Z",
  renewalInitiateAt: "2027-01-30T00:00:00.000Z",
  graceUntil: null,
  cancelAtPeriodEnd: false,
  pausedUntil: null,
  seats: 1,
  mandateId: "mandate_1",
};

const CREDITS: CreditsSummary = {
  workspaceId: "01JWORKSPACE",
  balanceTenths: 4_900,
  monthlyGrantTenths: 5_000,
  grantResetAt: "2027-02-01T00:00:00.000Z",
  lots: [
    {
      id: "lot_1",
      source: "grant",
      grantedTenths: 5_000,
      remainingTenths: 4_900,
      expiresAt: "2027-02-01T00:00:00.000Z",
      createdAt: "2027-01-01T00:00:00.000Z",
    },
  ],
};

const STREAK: StreakView = {
  eligible: true,
  holdout: false,
  creditsOnly: false,
  level: 2,
  publishDaysThisWeek: 3,
  bar: 3,
  paused: false,
  freezesRemaining: 2,
  consecutiveWeeks: 1,
  weekWindowStart: "2027-01-04",
  weekWindowEnd: "2027-01-11",
  nextRewardLabel: "10% off your next renewal at L3",
  discountPercent: 5,
  creditGrantTenths: 0,
};

describe("<OverviewPanel /> streak widget (M10: was gated on the wrong flag key)", () => {
  it("mounts the streak widget on /billing when growth.streakWidget is on", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
        "/streak": STREAK,
      },
      config: { flags: { "growth.streakWidget": true } },
    });

    const summary = await screen.findByTestId("streak-widget-summary");
    expect(summary).toHaveTextContent("3 of 3 publish days · L2 · 2 freezes left");
  });

  it("never mounts the streak widget when growth.streakWidget is off", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
        "/streak": STREAK,
      },
      config: { flags: {} },
    });

    await screen.findByTestId("credits-card");
    expect(screen.queryByTestId("streak-widget-slot")).toBeNull();
  });
});

describe("<OverviewPanel />", () => {
  it("shows the plan, status and renewal date, with the Autopay mandate cap named", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
      },
    });
    const summary = await screen.findByTestId("plan-renewal-summary");
    expect(summary).toHaveTextContent("1 February 2027");
    expect(summary).toHaveTextContent("cap ₹699");
    expect(screen.getByText(/^creator$/i)).toBeInTheDocument();
  });

  it("shows the Free plan card when there is no subscription", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": null,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
      },
    });
    // The canvas names the plan on its own line under a "Your plan" kicker,
    // so the heading is the plan's name and nothing else.
    await waitFor(() => {
      expect(screen.getByTestId("plan-card")).toHaveTextContent("Your plan");
    });
    expect(screen.getByTestId("plan-card")).toHaveTextContent("Free");
  });

  it("shows the credit lots with their expiry", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
      },
    });
    const lots = await screen.findByTestId("credit-lots");
    expect(lots).toHaveTextContent("grant");
    expect(lots).toHaveTextContent("expires 1 February 2027");
  });

  it("explains the consequence before cancelling, and only cancels on confirmation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
        "/billing/subscription/cancel": { ...ACTIVE_SUBSCRIPTION, cancelAtPeriodEnd: true },
      },
    });
    await screen.findByTestId("cancel-subscription");
    await user.click(screen.getByTestId("cancel-subscription"));

    expect(screen.getByText(/reverts to Free/i)).toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-subscription-action"));

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-subscription-action")).toBeNull();
    });
  });

  it("opens the checkout sheet from Upgrade — never a dead end", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
        "/billing/plans": [],
        "/workspaces/01JWORKSPACE": {
          id: "01JWORKSPACE",
          currency: "INR",
          billingCountry: "IN",
          billingCountryConfirmedAt: "2027-01-01T00:00:00.000Z",
          billingStateCode: "27",
          gstin: null,
          legalName: null,
          currencyLocked: false,
          role: "owner",
        },
      },
    });
    await screen.findByTestId("overview-upgrade");
    await user.click(screen.getByTestId("overview-upgrade"));
    expect(await screen.findByTestId("checkout-sheet")).toBeInTheDocument();
  });

  it("shows admin-granted credits and hides checkout when Razorpay is not configured", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
      },
      config: { razorpayEnabled: false },
    });

    expect(await screen.findByTestId("free-stack-billing")).toHaveTextContent(
      "Credits are granted by your admin",
    );
    expect(screen.queryByTestId("overview-upgrade")).toBeNull();
    expect(screen.queryByTestId("checkout-sheet")).toBeNull();
    // The Invoices tab is hidden in this build (F07-C1), so its shortcut goes too.
    expect(screen.queryByTestId("billing-history-shortcut")).toBeNull();
  });

  it("keeps the billing-history shortcut when Razorpay is configured", async () => {
    renderWithProviders(<OverviewPanel />, {
      routes: {
        "/billing/subscription": ACTIVE_SUBSCRIPTION,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
        "/billing/mandates": [],
      },
    });
    expect(await screen.findByTestId("billing-history-shortcut")).toHaveAttribute(
      "href",
      "/billing/invoices",
    );
  });
});
