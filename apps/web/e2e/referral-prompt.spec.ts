import { signUpAndSkipOnboarding } from "./auth-helpers";
import { API_ORIGIN, expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";

/**
 * The give-get sheet (B07b, brief §3): shown once per workspace, an axe
 * pass while it is open.
 *
 * `GET /referrals/me` and `POST /referrals/prompt/shown` are mocked at the
 * network boundary rather than driven through a real export — the grant
 * plumbing itself (claim, the `export.completed` listener, the cap, the
 * abuse checks, idempotency, the tiered bonus) is exercised end to end
 * against a real database in `apps/api/test/referrals.e2e-spec.ts` and
 * `referrals-http.e2e-spec.ts`; this suite is about the sheet's own
 * behaviour — it opens when the server says to, marks itself shown, does
 * not reappear, and is accessible — which a mocked `promptEligible` flag
 * proves without needing a real render pipeline in a browser-driven suite.
 */

const ELIGIBLE_STATS = {
  code: "AK-7Q2X9M",
  pending: 0,
  granted: 0,
  rejected: 0,
  bonusGrantedAt: null,
  promptShownAt: null,
  promptEligible: true,
};

test("the give-get sheet shows once, marks itself shown, and passes axe", async ({ page }) => {
  let shown = false;

  await page.route(`${API_ORIGIN}/referrals/me`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...ELIGIBLE_STATS,
        promptEligible: !shown,
        promptShownAt: shown ? "2026-09-02T00:00:00.000Z" : null,
      }),
    });
  });
  await page.route(`${API_ORIGIN}/referrals/prompt/shown`, async (route) => {
    shown = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ shownAt: "2026-09-02T00:00:00.000Z" }),
    });
  });

  await signUpAndSkipOnboarding(page, "referral-prompt");

  const sheet = page.getByTestId("referral-prompt-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByText("Give 30 credits, get 30 credits")).toBeVisible();
  await expect(page.getByLabel("Your code")).toHaveValue("AK-7Q2X9M");
  await expectNoSeriousA11yViolations(page, "give-get sheet");

  await page.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  // A reload re-mounts the shell; the sheet must not reopen once shown.
  await gotoHydrated(page, "/studio");
  await expect(page.getByTestId("referral-prompt-sheet")).not.toBeAttached();
});
