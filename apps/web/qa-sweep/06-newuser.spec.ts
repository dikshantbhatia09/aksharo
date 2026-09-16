import { expect, test } from "@playwright/test";

import { record, shot, watch } from "./diag";
import { gotoHydrated, waitForHydration } from "../e2e/fixtures";

import type { Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";

async function signUp(page: Page, label: string): Promise<string> {
  const email = `qa-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;
  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Priya Sharma");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByTestId("signup-continue").click();
  await page.getByLabel("Date of birth").fill("1995-04-12");
  await page.getByTestId("age-consent-submit").click();
  await expect(page.getByTestId("signup-sent")).toBeVisible();
  await gotoHydrated(page, "/login?next=/studio");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await waitForHydration(page);
  return email;
}

async function dismissOverlays(page: Page): Promise<void> {
  await page.addLocatorHandler(page.getByTestId("whats-new-modal"), async (modal) => {
    await modal.getByRole("button", { name: "Got it" }).click();
  });
  await page.addLocatorHandler(page.getByTestId("coach-mark"), async (mark) => {
    const skip = mark.getByTestId("coach-mark-skip");
    await skip.waitFor({ state: "visible", timeout: 5_000 });
    await skip.click();
  });
}

test("new user: onboarding, sample project, first transcription attempt", async ({ page }) => {
  watch(page, "newuser");
  await dismissOverlays(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const email = await signUp(page, "new");
  record({ kind: "newuser", where: "account", detail: email });

  // Walk the real onboarding rather than skipping it.
  await page.waitForTimeout(1200);
  await shot(page, "new-onboarding-1");
  const onboardingText = await page.locator("main").innerText();
  record({
    kind: "newuser",
    where: "onboarding step 1",
    detail: onboardingText.split(/\s*\n\s*/).join(" / ").slice(0, 600),
  });
  const skip = page.getByTestId("onboarding-skip");
  if ((await skip.count()) > 0) await skip.click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForTimeout(2500);
  await shot(page, "new-home");

  const sample = page.getByRole("button", { name: /try with a sample/i }).or(
    page.getByRole("link", { name: /try with a sample/i }),
  );
  record({ kind: "newuser", where: "sample cta", detail: String(await sample.count()) });
  if ((await sample.count()) > 0) {
    await sample.first().click();
    await page.waitForTimeout(9000);
    await shot(page, "new-sample-clicked");
    record({ kind: "newuser", where: "url after sample", detail: page.url() });
    const body = await page.locator("body").innerText();
    record({
      kind: "newuser",
      where: "sample result",
      detail: body.split(/\s*\n\s*/).join(" / ").slice(0, 900),
    });
  }

  await page.goto("/projects", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "new-projects");
  const projects = await page.locator("main").innerText();
  record({
    kind: "newuser",
    where: "projects list",
    detail: projects.split(/\s*\n\s*/).join(" / ").slice(0, 700),
  });
});
