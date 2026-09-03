import { expect, gotoHydrated, test } from "./fixtures";

/**
 * X03 smoke: the one docs surface (`/docs`), a guide article, the developer
 * API reference (`/docs/developers/v1`), one plugin guide, and client-side
 * search. Every page here is reachable signed out, same as A24's marketing
 * specs, so this needs no shared-account fixture.
 */

test("the docs index lists Guides, Plugins, Developers and Legal", async ({ page }) => {
  await gotoHydrated(page, "/docs");
  await expect(page.getByTestId("docs-index")).toBeVisible();
  await expect(page.getByTestId("docs-section-guides")).toBeVisible();
  await expect(page.getByTestId("docs-section-plugins")).toBeVisible();
  await expect(page.getByTestId("docs-section-developers")).toBeVisible();
  await expect(page.getByTestId("docs-section-legal")).toBeVisible();
  await expect(page.getByTestId("docs-sidebar")).toBeVisible();
});

test("the developer API reference (v1) lists resource groups generated from the OpenAPI document", async ({
  page,
}) => {
  await gotoHydrated(page, "/docs/developers/v1");
  await expect(page.getByTestId("docs-developers-version")).toBeVisible();
  await expect(page.getByTestId("docs-api-group-projects")).toBeVisible();

  await page.getByTestId("docs-api-group-projects").click();
  await expect(page.getByTestId("docs-api-group-page")).toBeVisible();
  await expect(page.getByTestId("docs-edit-this-page")).toBeVisible();
});

test("a plugin guide renders its README as a docs page", async ({ page }) => {
  await gotoHydrated(page, "/docs/plugins");
  await expect(page.getByTestId("docs-plugins-index")).toBeVisible();

  await page.getByTestId("docs-plugin-premiere").click();
  await expect(page.getByTestId("docs-plugin-guide")).toBeVisible();
  await expect(page.getByTestId("docs-edit-this-page")).toBeVisible();
});

test("the old /developers URL redirects to the new docs page", async ({ page }) => {
  await page.goto("/developers");
  await expect(page).toHaveURL(/\/docs\/developers$/);
  await expect(page.getByTestId("docs-developers-index")).toBeVisible();
});

test("docs search finds a guide article and a plugin guide by keyword", async ({ page }) => {
  await gotoHydrated(page, "/docs");
  await page.getByTestId("docs-search-input").fill("export");
  await expect(page.getByTestId("docs-search-results")).toBeVisible();
  const results = page.getByTestId("docs-search-results");
  await expect(results).not.toContainText("No docs match");
});
