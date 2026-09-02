import { expect, expectNoSeriousA11yViolations, gotoHydrated, signIn, test } from "./fixtures";

/**
 * The affiliate dashboard (brief §8: "e2e dashboard renders with fake data").
 *
 * The shared account has no affiliate profile, so `/affiliate` renders the
 * apply form; submitting it creates a real `pending` affiliate through the
 * real API (backed by this worktree's own database) and the dashboard then
 * renders the pending-review state — both screens get an axe pass. Reaching
 * `approved` needs an admin action (B13's own UI, out of this work
 * package's scope per the brief's "Out of scope" line), so the fully
 * populated stats dashboard is covered by the API-level e2e suite
 * (`apps/api/test/affiliates.e2e-spec.ts`) instead, exactly the way B01's
 * mandate math is unit/e2e-tested at the API layer and only smoke-tested here.
 */

test("affiliate: apply form renders, submits, and is accessible", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount);
  await gotoHydrated(page, "/affiliate");

  const applyForm = page.getByTestId("affiliate-apply-form");
  const dashboard = page.getByTestId("affiliate-dashboard");

  if (await dashboard.isVisible().catch(() => false)) {
    // A previous run in this worker already applied; that is a valid state
    // to axe-check too, and there is nothing left for this test to submit.
    await expectNoSeriousA11yViolations(page, "affiliate dashboard (existing profile)");
    return;
  }

  await expect(applyForm).toBeVisible();
  await expect(page.getByTestId("affiliate-asci-clause")).toContainText(
    "you have a material connection with us and must disclose it",
  );
  await expectNoSeriousA11yViolations(page, "affiliate apply form");

  await page.getByLabel("Legal name").fill("Playwright Affiliate");
  await page.getByTestId("affiliate-pan-input").fill("ABCDE1234F");
  await page.getByLabel("UPI VPA").fill("pw-affiliate@upi");
  await page.getByLabel("Account holder name").fill("Playwright Affiliate");
  await page.getByTestId("affiliate-accept-disclosure").click();

  const submit = page.getByTestId("affiliate-apply-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(dashboard).toBeVisible();
  await expect(page.getByText("Pending review")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "affiliate dashboard (pending)");
});

test("affiliate: asset pack page renders the ASCI labels and is accessible", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount);
  await gotoHydrated(page, "/affiliate/assets");

  await expect(page.getByTestId("affiliate-disclosure-labels")).toBeVisible();
  await expect(page.getByTestId("affiliate-scripts")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "affiliate asset pack");
});
