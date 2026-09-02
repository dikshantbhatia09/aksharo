import { createHash, createHmac } from "node:crypto";

import {
  API_ORIGIN,
  expect,
  expectNoSeriousA11yViolations,
  gotoHydrated,
  signUpAndVerify,
  test,
} from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * B03 acceptance: Free → Creator monthly INR via UPI Autopay, Studio yearly's
 * half-yearly explanation, tax-profile validation, the invoices list, and an
 * axe pass — chromium and webkit both run this file (`playwright.config.ts`'s
 * two projects).
 *
 * The fake provider's own webhook envelope and signature scheme
 * (`apps/api/src/billing/providers/webhook-envelope.ts`) is reproduced here so
 * the "success" test can drive it directly, exactly as
 * `apps/api/src/billing/README.md`'s "Manual live-key smoke test" describes:
 * "in tests the fake provider's success hook drives the webhook" — there is no
 * way to complete a real payment against `rzp_test_fake` from a browser
 * automation script, so this is the intended test seam, not a workaround.
 * `RAZORPAY_KEY_ID`/`_KEY_SECRET`/`_WEBHOOK_SECRET` are unset in this
 * worktree's `.env`, so `createBillingProvider` selects `FakeProvider` with
 * its documented default webhook secret.
 */

const FAKE_WEBHOOK_SECRET = "fake_test_webhook_secret";

function signWebhook(rawBody: string): string {
  return createHmac("sha256", FAKE_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

interface RazorpayWebhookBody {
  entity: "event";
  event: string;
  created_at: number;
  payload: {
    subscription?: { entity: { id: string; status: string; notes?: Record<string, string> } };
    payment?: {
      entity: {
        id: string;
        status: string;
        amount: number;
        currency: string;
        method: string;
        subscription_id?: string;
      };
    };
  };
}

/** A `subscription.activated` webhook, shaped exactly like `FakeProvider.emitWebhook`. */
function buildActivatedWebhook(input: {
  providerSubscriptionId: string;
  amountMinor: number;
  currency: string;
}): { rawBody: string; signature: string } {
  const body: RazorpayWebhookBody = {
    entity: "event",
    event: "subscription.activated",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      subscription: { entity: { id: input.providerSubscriptionId, status: "active" } },
      payment: {
        entity: {
          id: `pay_e2e_${createHash("sha1").update(input.providerSubscriptionId).digest("hex").slice(0, 12)}`,
          status: "captured",
          amount: input.amountMinor,
          currency: input.currency,
          method: "upi",
          subscription_id: input.providerSubscriptionId,
        },
      },
    },
  };
  const rawBody = JSON.stringify(body);
  return { rawBody, signature: signWebhook(rawBody) };
}

async function deliverWebhook(
  page: Page,
  input: { providerSubscriptionId: string; amountMinor: number; currency: string },
): Promise<void> {
  const { rawBody, signature } = buildActivatedWebhook(input);
  const response = await page.request.post(`${API_ORIGIN}/billing/webhooks/razorpay`, {
    data: rawBody,
    headers: { "content-type": "application/json", "x-razorpay-signature": signature },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Sign up, confirm, sign in, skip onboarding, land on Home ("/", A14 — onboarding's own skip/finish both `router.replace("/")`). */
async function signInFreshAccount(page: Page, label: string): Promise<void> {
  await signUpAndVerify(page, label);
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL((url) => url.pathname === "/");
}

test("Free -> Creator monthly INR via UPI Autopay: tax profile, method, webhook, entitlement refresh", async ({
  page,
}) => {
  await signInFreshAccount(page, "creator-upi");

  await gotoHydrated(page, "/billing/plans");
  await page.getByTestId("plan-card-creator-choose").click();

  // Step 1: tax profile (India, State required).
  await expect(page.getByTestId("tax-profile-step")).toBeVisible();
  await page.getByTestId("tax-state-select").selectOption("27"); // Maharashtra
  await page.getByTestId("tax-profile-submit").click();

  // Step 2: method.
  await expect(page.getByTestId("method-step")).toBeVisible();
  await page.getByTestId("method-upi_autopay").click();

  // Step 3: confirm, GST-inclusive with the break-up.
  await expect(page.getByTestId("confirm-step")).toBeVisible();
  await expect(page.getByTestId("confirm-amount")).toContainText("₹699");
  await expect(page.getByTestId("confirm-gst-breakup")).toContainText("18% GST");

  const checkoutResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/billing/checkout") && response.request().method() === "POST",
  );
  await page.getByTestId("confirm-pay").click();
  const response = await checkoutResponse;
  const body = (await response.json()) as {
    providerSubscriptionId?: string;
    amountMinor: number;
    currency: string;
  };
  expect(
    body.providerSubscriptionId,
    "fake checkout always returns a provider subscription id",
  ).toBeTruthy();

  // Step 4: webhook-driven status polling.
  await expect(page.getByTestId("checkout-processing")).toBeVisible();

  await deliverWebhook(page, {
    providerSubscriptionId: body.providerSubscriptionId ?? "",
    amountMinor: body.amountMinor,
    currency: body.currency,
  });

  await expect(page.getByTestId("checkout-success")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("checkout-done").click();

  // Entitlement refresh without a reload: the Overview plan card now says Creator.
  await gotoHydrated(page, "/billing");
  await expect(page.getByTestId("plan-card")).toContainText("creator", { ignoreCase: true });
  await expect(page.getByTestId("plan-renewal-summary")).toContainText("UPI Autopay");
});

test("Studio yearly shows the two half-yearly UPI debits explanation", async ({ page }) => {
  await signInFreshAccount(page, "studio-half");

  await gotoHydrated(page, "/billing/plans");
  await page.getByTestId("plan-interval-year").click();
  await expect(page.getByTestId("plan-card-studio-halfyear")).toContainText(
    "two half-yearly debits",
  );
  await expect(page.getByTestId("plan-card-studio-halfyear")).toContainText("₹9,996");

  await page.getByTestId("plan-card-studio-choose").click();
  await expect(page.getByTestId("tax-profile-step")).toBeVisible();
  await page.getByTestId("tax-state-select").selectOption("27");
  await page.getByTestId("tax-profile-submit").click();

  await expect(page.getByTestId("halfyear-explainer")).toContainText("two half-yearly debits");
  await expect(page.getByTestId("method-upi_autopay")).toBeDisabled();
});

test("the tax-profile step refuses to submit without a State for India", async ({ page }) => {
  await signInFreshAccount(page, "tax-validation");

  await gotoHydrated(page, "/billing/plans");
  await page.getByTestId("plan-card-creator-choose").click();
  await expect(page.getByTestId("tax-profile-step")).toBeVisible();

  await page.getByTestId("tax-profile-submit").click();
  await expect(page.getByTestId("tax-profile-error")).toContainText(/state is required/i);
  // Still on the tax-profile step — never silently advanced.
  await expect(page.getByTestId("tax-profile-step")).toBeVisible();

  // A malformed GSTIN is flagged before it ever reaches the server.
  await page.getByTestId("tax-state-select").selectOption("27");
  await page.getByLabel(/GSTIN/i).fill("27AAPFU0939F1ZZ"); // wrong check digit
  await expect(page.getByText(/check digit does not match/i)).toBeVisible();
});

test("the invoices list renders (empty state is honest, not an error, while B05 is in flight)", async ({
  page,
}) => {
  await signInFreshAccount(page, "invoices-list");

  await gotoHydrated(page, "/billing/invoices");
  const empty = page.getByTestId("invoices-empty");
  const list = page.getByTestId("invoices-list");
  await expect(empty.or(list)).toBeVisible();
});

test("the billing overview is axe clean", async ({ page }) => {
  await signInFreshAccount(page, "billing-axe-overview");
  await gotoHydrated(page, "/billing");
  await expectNoSeriousA11yViolations(page, "/billing");
});

test("the plans page is axe clean", async ({ page }) => {
  await signInFreshAccount(page, "billing-axe-plans");
  await gotoHydrated(page, "/billing/plans");
  await expectNoSeriousA11yViolations(page, "/billing/plans");
});
