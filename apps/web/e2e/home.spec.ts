import { signUpAndSkipOnboarding } from "./auth-helpers";
import { expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";

/**
 * Home (`/`, 08 §Home, F-101/F-102): greeting, drop zone, quick-pick,
 * sample project, and the Recent grid — reached only by an authenticated
 * request being rewritten there by `middleware.ts` (`smoke.spec.ts` already
 * covers the signed-out "/" placeholder untouched by that rewrite).
 */

test("greets the signed-in user and lands on the real Home, not the marketing page", async ({
  page,
}) => {
  await signUpAndSkipOnboarding(page, "home");
  await expect(page.getByTestId("home-view")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good to see you");
  // The URL bar still reads "/" — the rewrite is invisible.
  expect(new URL(page.url()).pathname).toBe("/");
});

test("the drop zone is reachable and openable from the keyboard", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "home");
  const button = page.getByRole("button", { name: /drop videos or audio here/i });
  await button.focus();
  await expect(button).toBeFocused();

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const chooser = await fileChooserPromise;
  expect(chooser.isMultiple()).toBe(true);
});

test("the quick-pick row defaults to Hinglish (Roman) and lets the style catalogue load from the API", async ({
  page,
}) => {
  await signUpAndSkipOnboarding(page, "home");
  await expect(page.getByTestId("quick-pick-language")).toHaveText("Hinglish (Roman)");

  await page.getByTestId("quick-pick-style").click();
  await expect(page.getByTestId("style-quick-pick-sheet")).toBeVisible();
  // Punch Pop is first in the seeded catalogue and the brief's own example.
  await expect(page.getByTestId("style-picker-tile-punch-pop")).toBeVisible();
  await page.getByTestId("style-picker-tile-punch-pop").click();
  await expect(page.getByTestId("quick-pick-style")).toContainText("Punch Pop");
});

test('"Try with a sample" creates a real project and opens it', async ({ page }) => {
  await signUpAndSkipOnboarding(page, "home");
  await page.getByTestId("try-with-sample").click();
  // A generous timeout: the very first real S3 PUT any test in a run makes
  // pays a one-time connection-pool warm-up cost against the shared MinIO;
  // every one after it is a few seconds (observed consistently across many
  // runs of this suite).
  await page.waitForURL(/\/p\//, { timeout: 60_000 });
  expect(new URL(page.url()).pathname).toMatch(/^\/p\/[0-9A-Z]{26}$/);
});

test("the empty state offers a sample before anything has been uploaded", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "home");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("try-with-sample")).toBeVisible();
});

test("Home is axe-clean", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "home");
  await expectNoSeriousA11yViolations(page, "Home");
});

test("the codename never reaches Home", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "home");
  const visible = await page.evaluate(() => document.body.innerText.toLowerCase());
  expect(visible).not.toContain("montaj");
});

test("signed-out visitors still see the marketing placeholder at the same URL", async ({
  page,
}) => {
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("home-heading")).toHaveText("Aksharo");
  await expect(page.getByTestId("home-view")).toHaveCount(0);
});
