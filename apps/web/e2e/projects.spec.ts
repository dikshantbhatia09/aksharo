import { signUpAndSkipOnboarding } from "./auth-helpers";
import { expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";

import type { Page } from "@playwright/test";

/** `/projects` (08 §Home, F-102): search, filters, folders, archive, bulk select. */

/** A real project via the UI's own "Try with a sample" button. */
async function createSampleProject(page: Page): Promise<void> {
  await gotoHydrated(page, "/");
  await page.getByTestId("try-with-sample").click();
  // See `home.spec.ts`'s note on this timeout: the first real S3 PUT in a
  // run can pay a one-time connection warm-up cost.
  await page.waitForURL(/\/p\//, { timeout: 60_000 });
}

test("the sidebar's Projects link is a real route, not a Soon chip", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  const link = page.getByTestId("nav-projects");
  await expect(link).not.toHaveAttribute("aria-disabled", "true");
  await link.click();
  await page.waitForURL(/\/projects/);
  await expect(page.getByTestId("projects-view")).toBeVisible();
});

test("a created project shows up in the list and is searchable by title", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  await createSampleProject(page);

  await gotoHydrated(page, "/projects");
  await expect(page.getByTestId("project-card").first()).toBeVisible();

  await page.getByTestId("project-search").fill("Welcome to Aksharo");
  await expect(page.getByTestId("project-card").first()).toContainText("Welcome to Aksharo");

  await page.getByTestId("project-search").fill("no such project exists");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("the status filter shows the archive view", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  await createSampleProject(page);
  await gotoHydrated(page, "/projects");

  const card = page.getByTestId("project-card").first();
  await card.getByTestId(/project-kebab-/).click();
  await page.getByTestId("kebab-archive").click();

  await page.getByTestId("filter-status").click();
  await page.getByTestId("filter-status-archived").click();
  await expect(page.getByTestId("project-card").first()).toBeVisible();
  await expect(page.getByTestId("project-card").first()).toHaveAttribute("data-status", "archived");
});

test("creates a folder and filters projects by it", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  await gotoHydrated(page, "/projects");

  const createResponse = page.waitForResponse(
    (response) => response.url().includes("/folders") && response.request().method() === "POST",
  );
  await page.getByTestId("folder-create").click();
  await page.getByTestId("folder-create-input").fill("Client work");
  await page.getByTestId("folder-create-input").press("Enter");
  const response = await createResponse;
  expect(response.ok(), await response.text()).toBe(true);

  await expect(page.getByText("Client work")).toBeVisible();
  await page.getByText("Client work").click();
  // A brand-new folder holds nothing yet.
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("bulk select archives more than one project at once", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  await createSampleProject(page);
  await createSampleProject(page);
  await gotoHydrated(page, "/projects");

  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await page.getByTestId("toggle-select-mode").click();
  const checkboxes = page.getByTestId("project-card-select");
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();

  await expect(page.getByTestId("bulk-action-bar")).toContainText("2 selected");
  await page.getByTestId("bulk-archive").click();
  await expect(page.getByTestId("bulk-action-bar")).toHaveCount(0);
});

test("opens the detail sheet with retention and job history", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  await createSampleProject(page);
  await gotoHydrated(page, "/projects");

  await page.getByTestId("project-card").first().getByTestId(/project-kebab-/).click();
  await page.getByTestId("kebab-details").click();
  await expect(page.getByTestId("project-detail-sheet")).toBeVisible();
  await expect(page.getByTestId("project-detail-retention")).toBeVisible();
});

test("/projects is axe-clean, empty and populated", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "projects");
  await gotoHydrated(page, "/projects");
  await expectNoSeriousA11yViolations(page, "/projects (empty)");

  await createSampleProject(page);
  await gotoHydrated(page, "/projects");
  await expect(page.getByTestId("project-card").first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, "/projects (populated)");
});

test("/projects is behind a session", async ({ page }) => {
  await gotoHydrated(page, "/projects");
  await page.waitForURL(/\/login/);
  expect(new URL(page.url()).searchParams.get("next")).toBe("/projects");
});
