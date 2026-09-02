import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CheckoutSheet } from "./checkout-sheet";

import type { PlanView, WorkspaceBillingView } from "@/lib/billing/types";

import * as razorpay from "@/lib/billing/razorpay";
import { renderWithProviders, testAccessToken } from "@/test/harness";

vi.mock("@/lib/billing/razorpay", () => ({
  openRazorpayCheckout: vi.fn(),
  loadRazorpayCheckout: vi.fn(),
}));

// The shared Vitest preset (`packages/config/vitest.base.mjs`) sets
// `restoreMocks: true`, which clears every mock's implementation before each
// test — so a `mockResolvedValue` set once at module scope would only survive
// the first test. Re-armed here instead.
beforeEach(() => {
  vi.mocked(razorpay.openRazorpayCheckout).mockResolvedValue({ status: "dismissed" });
  vi.mocked(razorpay.loadRazorpayCheckout).mockResolvedValue(null);
});

const PLANS: PlanView[] = [
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
];

const CONFIRMED_WORKSPACE: WorkspaceBillingView = {
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

const UNCONFIRMED_WORKSPACE: WorkspaceBillingView = {
  ...CONFIRMED_WORKSPACE,
  billingCountryConfirmedAt: null,
  billingStateCode: null,
};

const NO_SUBSCRIPTION_ROUTE = { "/billing/subscription": null };

describe("<CheckoutSheet /> — tax profile step", () => {
  it("opens on the tax-profile step when the workspace has not confirmed billing yet", async () => {
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": UNCONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    expect(await screen.findByTestId("tax-profile-step")).toBeInTheDocument();
  });

  it("requires a State for India before it will submit (D41)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": UNCONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    await screen.findByTestId("tax-profile-step");
    await user.click(screen.getByTestId("tax-profile-submit"));
    expect(await screen.findByTestId("tax-profile-error")).toHaveTextContent(/state is required/i);
  });

  it("shows a read-only notice for a non-owner instead of the form", async () => {
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        accessToken: testAccessToken({ role: "admin" }),
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": UNCONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    expect(await screen.findByTestId("tax-profile-owner-only")).toBeInTheDocument();
    expect(screen.queryByTestId("tax-state-select")).toBeNull();
  });
});

describe("<CheckoutSheet /> — method step", () => {
  it("skips the method step for a pay-once purchase", async () => {
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "once" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": CONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    expect(await screen.findByTestId("method-pay-once")).toBeInTheDocument();
    expect(screen.queryByTestId("method-upi_autopay")).toBeNull();
  });

  it("shows the Studio-yearly half-yearly-debits explainer and disables netbanking", async () => {
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "studio", interval: "year" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": CONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    expect(await screen.findByTestId("halfyear-explainer")).toHaveTextContent(
      "two half-yearly debits",
    );
    expect(screen.getByTestId("method-netbanking")).toBeDisabled();
  });

  it("moves to confirm with the chosen method", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": CONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    await screen.findByTestId("method-step");
    await user.click(screen.getByTestId("method-upi_autopay"));
    expect(await screen.findByTestId("confirm-step")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-amount")).toHaveTextContent("₹699");
    expect(screen.getByTestId("confirm-gst-breakup")).toHaveTextContent("18% GST");
  });
});

describe("<CheckoutSheet /> — confirm and the mandate cap conflict", () => {
  it("submits the checkout and moves to the gateway/processing step on success", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": CONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
          "/billing/checkout": {
            subscriptionId: "sub_1",
            status: "pending",
            keyId: "rzp_test_fake",
            amountMinor: 69_900,
            currency: "INR",
            interval: "month",
            mandateCapMinor: 69_900,
            method: "upi_autopay",
            providerSubscriptionId: "sub_fake_1",
          },
        },
      },
    );
    await screen.findByTestId("method-step");
    await user.click(screen.getByTestId("method-upi_autopay"));
    await screen.findByTestId("confirm-step");
    await user.click(screen.getByTestId("confirm-pay"));

    expect(await screen.findByTestId("checkout-processing")).toBeInTheDocument();
  });

  it("shows the returned alternatives when a UPI Autopay mandate is refused (409 billing/mandate_cap_exceeded)", async () => {
    const user = userEvent.setup();
    // Creator/month, not Studio/year: the client-side hint
    // (`upiAutopayLikelyRefused`) already disables the UPI Autopay button for
    // a combination it can tell is over the cap (covered by the "Studio
    // yearly" test above), so reaching the server's own refusal here needs a
    // combination the client did *not* know to block — precisely the
    // belt-and-braces case this response exists for.
    renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": CONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
          "/billing/checkout": new Response(
            JSON.stringify({
              error: {
                code: "billing/mandate_cap_exceeded",
                message: "A UPI Autopay mandate cannot exceed ₹15,000.",
                details: {
                  alternatives: [
                    {
                      kind: "halfyear_upi",
                      interval: "halfyear",
                      method: "upi_autopay",
                      amountMinor: 999_600,
                      currency: "INR",
                    },
                  ],
                },
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        },
      },
    );
    await screen.findByTestId("method-step");
    await user.click(screen.getByTestId("method-upi_autopay"));
    await screen.findByTestId("confirm-step");
    await user.click(screen.getByTestId("confirm-pay"));

    const alternative = await screen.findByTestId("alternative-halfyear_upi");
    expect(within(alternative).getByText("₹9,996")).toBeInTheDocument();

    await user.click(alternative);
    expect(await screen.findByTestId("confirm-step")).toBeInTheDocument();
  });
});

// Kept last in the file, deliberately: this is the one test whose fetch mock
// is replaced mid-test (`PUT /workspaces/{id}/tax-profile` needs a response
// distinct from the `GET` the harness's route table already answered), and
// doing that appeared to leave a stray in-flight request that could still
// resolve into a later, unrelated test's render — moving it to the end
// removes the ordering dependency rather than papering over a flaky
// assertion.
describe("<CheckoutSheet /> — tax profile confirmation round trip", () => {
  it("moves to the method step once the tax profile is confirmed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <CheckoutSheet
        open
        onOpenChange={() => {}}
        selection={{ planKey: "creator", interval: "month" }}
      />,
      {
        routes: {
          "/billing/plans": PLANS,
          "/workspaces/01JWORKSPACE": UNCONFIRMED_WORKSPACE,
          ...NO_SUBSCRIPTION_ROUTE,
        },
      },
    );
    await screen.findByTestId("tax-profile-step");

    // `PUT /workspaces/{id}/tax-profile` (workspaces.dto.ts) is its own path,
    // distinct from the `GET /workspaces/{id}` already resolved above, so it
    // gets its own route rather than needing a method-aware override. Every
    // other route keeps answering what it did before (rather than 404ing):
    // the test harness's `QueryClient` does not disable `refetchOnWindowFocus`
    // the way the app's own `Providers` does, so a stray refetch of, say,
    // `GET /billing/plans` must not turn into an error that derails the flow.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/workspaces/01JWORKSPACE/tax-profile") {
        return Promise.resolve(json(CONFIRMED_WORKSPACE));
      }
      if (url.pathname === "/workspaces/01JWORKSPACE")
        return Promise.resolve(json(UNCONFIRMED_WORKSPACE));
      if (url.pathname === "/billing/plans") return Promise.resolve(json(PLANS));
      if (url.pathname === "/billing/subscription") return Promise.resolve(json(null));
      return Promise.resolve(
        json({ error: { code: "common/not_found", message: "Not found." } }, 404),
      );
    });

    await user.selectOptions(screen.getByTestId("tax-state-select"), "27");
    await user.click(screen.getByTestId("tax-profile-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("method-step")).toBeInTheDocument();
    });
  });
});
