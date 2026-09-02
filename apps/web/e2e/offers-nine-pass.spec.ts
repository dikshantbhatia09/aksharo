import { decodeAccessToken } from "@montaj/api-client";

import {
  API_ORIGIN,
  expect,
  gotoHydrated,
  signUpAndVerify,
  test,
  waitForHydration,
} from "./fixtures";

/**
 * B04 acceptance e2e: a Free user hits the watermark upsell panel, buys the
 * ₹9 clean export through Razorpay Checkout (faked — no real Razorpay account
 * in this environment, matching `apps/api/src/billing/README.md`'s own
 * FakeProvider policy), and the panel reports a clean manifest is ready.
 *
 * Two things this suite fakes, and why:
 *
 *  1. `window.Razorpay` — the real widget needs network access to Razorpay's
 *     servers, unavailable in a sandboxed CI run; `page.addInitScript`
 *     installs a stand-in whose `.open()` immediately calls the configured
 *     `handler`, exactly like a buyer completing the real widget instantly.
 *  2. The payment webhook — a client's "the widget said success" is never
 *     trusted (THREAT-MODEL: only the API's own webhook grants anything), so
 *     landing the payment for real means driving the exact same code path
 *     `test/billing.e2e-spec.ts` uses server-side: `POST
 *     /offers/dev/simulate-nine-pass-payment`, a dev-only route that only
 *     exists when `BILLING_PROVIDER` resolves to `FakeProvider` — see
 *     `offers-dev.controller.ts`'s doc comment for why it carries no bearer
 *     auth of its own.
 *
 * The signup gift is spent first (`POST /offers/dev/consume-signup-gift`) so
 * the panel's ₹9 row is the one under test, not the free-gift row a brand
 * new workspace would show instead.
 */

test("Free user: watermark panel → buys ₹9 (faked provider) → clean manifest is reported ready", async ({
  page,
}) => {
  test.slow();

  await signUpAndVerify(page, "ninepass");

  // Fake Razorpay Checkout: `.open()` resolves instantly with a fake payment id.
  await page.addInitScript(() => {
    function FakeRazorpay(
      this: { options: Record<string, unknown> },
      options: Record<string, unknown>,
    ) {
      this.options = options;
    }
    FakeRazorpay.prototype.open = function open(this: { options: Record<string, unknown> }): void {
      const handler = this.options["handler"] as (response: Record<string, string>) => void;
      handler({
        razorpay_payment_id: "pay_fake_e2e",
        razorpay_order_id: String(this.options["order_id"]),
      });
    };
    // @ts-expect-error -- test-only global, not the real Razorpay SDK's types.
    window.Razorpay = FakeRazorpay;
  });

  let bearerToken: string | null = null;
  page.on("request", (request) => {
    if (bearerToken !== null) return;
    const auth = request.headers()["authorization"];
    if (auth?.startsWith("Bearer ") === true) bearerToken = auth.slice("Bearer ".length);
  });

  await gotoHydrated(page, "/ui-kit/export-upsell");
  await expect(page.getByTestId("export-upsell-panel")).toBeVisible();

  await expect.poll(() => bearerToken, { timeout: 15_000 }).not.toBeNull();
  const claims = decodeAccessToken(bearerToken ?? "");
  expect(claims).not.toBeNull();
  const workspaceId = claims?.workspaceId ?? "";
  expect(workspaceId).not.toBe("");

  // Spend the signup gift so the ₹9 row, not the free-gift row, is under test.
  const consumeGift = await page.request.post(`${API_ORIGIN}/offers/dev/consume-signup-gift`, {
    data: { workspaceId },
  });
  expect(consumeGift.ok()).toBe(true);

  await page.reload();
  await waitForHydration(page);
  await expect(page.getByTestId("export-upsell-panel")).toBeVisible();
  await expect(page.getByTestId("export-upsell-buy-nine-pass")).toBeVisible();

  const checkoutResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/billing/passes/checkout") && response.request().method() === "POST",
  );
  await page.getByTestId("export-upsell-buy-nine-pass").click();
  const checkout = await checkoutResponse;
  const checkoutBody = (await checkout.json()) as { passPurchaseId: string };
  expect(checkoutBody.passPurchaseId).toBeTruthy();

  // Land the payment — the same in-process mechanism the API's own e2e suite
  // uses, exposed over HTTP for this browser-driven test (see file header).
  const simulate = await page.request.post(`${API_ORIGIN}/offers/dev/simulate-nine-pass-payment`, {
    data: { passPurchaseId: checkoutBody.passPurchaseId },
  });
  expect(simulate.ok()).toBe(true);

  // The panel polls `GET /offers/eligibility` after a successful checkout
  // until the pass shows available, then the demo page's own callback fires.
  await expect(page.getByTestId("export-upsell-demo-ready")).toBeVisible({ timeout: 35_000 });
});
