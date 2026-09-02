import { expect, expectNoSeriousA11yViolations, signIn, signUpAndVerify, test } from "./fixtures";

/**
 * B17: the code field's inline validation, the "what you make" → defaults
 * that carry onto the next transcribe request, and the final "you're set"
 * step's sample project. `auth.spec.ts` already covers the happy path with
 * no code typed; this file covers the code field and the defaults it feeds.
 */

test("an invalid code shows an inline error without blocking onboarding", async ({ page }) => {
  await signUpAndVerify(page, "onb-invalid-code");

  await page.getByTestId("choice-reels").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("choice-hi-Latn").click();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByRole("heading", { name: /How did you find us/ })).toBeVisible();
  await page.getByTestId("choice-friend").click();
  await page.getByTestId("onboarding-code").fill("not a real code");
  await page.getByTestId("onboarding-next").click();

  // Still on step 3 — the bad code did not advance the wizard.
  await expect(page.getByRole("heading", { name: /How did you find us/ })).toBeVisible();
  await expect(page.getByText(/doesn't look right/i)).toBeVisible();

  // Clearing it lets the wizard finish.
  await page.getByTestId("onboarding-code").fill("");
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
});

test("a referral-shaped code (AK-) is accepted and the wizard still finishes", async ({ page }) => {
  await signUpAndVerify(page, "onb-referral-code");

  await page.getByTestId("choice-youtube").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("choice-en-IN").click();
  await page.getByTestId("onboarding-next").click();

  await page.getByTestId("choice-search").click();
  // Well-formed but almost certainly unassigned — `claim` 404s server-side,
  // which the wizard must not surface as a blocking error (B07b: best-effort).
  await page.getByTestId("onboarding-code").fill("AK-ZZZZZZ");
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
});

test("what you make sets the aspect and style the next upload starts with", async ({ page }) => {
  await signUpAndVerify(page, "onb-defaults");

  await page.getByTestId("choice-youtube").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("choice-hi-Latn").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("choice-search").click();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  await page.getByTestId("onboarding-done").click();
  await page.waitForURL(/\/studio|\/$/);

  // "YouTube" defaults to 16:9 (`onboarding-flow.tsx`'s `MAKE_DEFAULTS`) —
  // the Home quick-pick row adopts it once `/me` answers.
  await expect(page.getByTestId("quick-pick-aspect")).toHaveText("16:9");
});

test("the profile menu's language switch renders Hindi onboarding-style strings", async ({
  page,
  sharedAccount,
}) => {
  await signIn(page, sharedAccount, "/settings/profile");
  await page.getByTestId("profile-menu").click();
  await expect(page.getByTestId("locale-switch")).toBeVisible();

  // The item stays open on select (`event.preventDefault()`, same as the
  // sign-out item) so its own label is the thing to watch switch languages —
  // no round trip through `PATCH /me` needed to observe it.
  await page.getByTestId("locale-switch").click();
  await expect(page.getByTestId("locale-switch")).toContainText("हिन्दी");

  // Not an axe pass here: the open `DropdownMenu` (`@montaj/ui`, not owned by
  // this work package) already fails `aria-hidden`-on-focusable-background on
  // every menu it renders, profile menu or not — a pre-existing issue outside
  // B17's file boundary, not something the language switch introduces.

  // Leave it in English so other tests sharing this account are unaffected.
  await page.getByTestId("locale-switch").click();
});

test("axe: the onboarding code field and the final step", async ({ page }) => {
  await signUpAndVerify(page, "onb-axe");
  await page.getByTestId("choice-reels").click();
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("choice-hi-Latn").click();
  await page.getByTestId("onboarding-next").click();
  await expectNoSeriousA11yViolations(page, "onboarding-source-step");

  await page.getByTestId("choice-friend").click();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByRole("heading", { name: "You're set" })).toBeVisible();
  await expectNoSeriousA11yViolations(page, "onboarding-finish-step");
});
