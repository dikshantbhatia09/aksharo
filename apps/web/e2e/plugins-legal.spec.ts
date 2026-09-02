import { expect, gotoHydrated, test } from "./fixtures";

/**
 * D65 plugin naming compliance, the legal "draft — pending counsel" banners,
 * the grievance officer page, and the home page's English/Hindi hero toggle.
 */

test("the plugins page uses the compliant product names, never a bare host name", async ({
  page,
}) => {
  await gotoHydrated(page, "/plugins");
  const text = await page.evaluate(() => document.body.innerText);

  expect(text).toContain("Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects");
  expect(text).toContain("Aksharo — works with DaVinci Resolve");

  // The exact violations D65 exists to prevent: a host name standing in for the
  // product name, and an implied-endorsement phrasing.
  expect(text).not.toMatch(/\bPremiere plugin\b/i);
  expect(text).not.toMatch(/\bResolve plugin\b/i);
  expect(text).not.toMatch(/endorsed by Aksharo/i);

  await expect(page.getByTestId("plugins-attribution")).toContainText(
    "not affiliated with or endorsed by Adobe or Blackmagic Design",
  );
});

test("the plugins page states honest capability notes rather than overclaiming", async ({
  page,
}) => {
  await gotoHydrated(page, "/plugins");
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).toContain("waiting on Adobe");
  expect(text).toContain("not supported by Resolve");
});

test("every legal page carries the draft-pending-counsel banner", async ({ page }) => {
  for (const path of [
    "/legal/privacy",
    "/legal/terms",
    "/legal/aup",
    "/legal/refunds",
    "/legal/dpa",
    "/legal/grievance",
  ]) {
    await gotoHydrated(page, path);
    await expect(page.getByTestId("legal-draft-banner")).toContainText("Draft — pending counsel");
  }
});

test("the privacy page renders the real itemised notice, not placeholder purposes", async ({
  page,
}) => {
  await gotoHydrated(page, "/legal/privacy");
  const purposes = page.getByTestId("privacy-notice-purposes");
  await expect(purposes).toContainText("Running the service");
  await expect(purposes).toContainText("Essential");
  await expect(purposes).toContainText("Remembering your preferences");
});

test("the grievance officer page publishes response-time targets", async ({ page }) => {
  await gotoHydrated(page, "/legal/grievance");
  const details = page.getByTestId("grievance-details");
  await expect(details).toContainText("grievance@aksharo.ai");
  await expect(details).toContainText("36 hours");
});

test("comparison pages show a dated, sourced claim for every fact", async ({ page }) => {
  for (const slug of ["kalakar", "captik", "submagic", "autocut"]) {
    await gotoHydrated(page, `/vs/${slug}`);
    await expect(page.getByTestId("comparison-verified")).toContainText("Last verified 2026-09-02");
    const rows = await page.getByTestId("comparison-table").locator("tbody tr").count();
    expect(rows).toBeGreaterThan(0);
  }
});

test("the home hero toggles between English and Hindi headline copy", async ({ page }) => {
  await gotoHydrated(page, "/");
  const headline = page.getByTestId("hero-headline");
  const english = await headline.textContent();

  await page.getByTestId("hero-locale-hi").click();
  await expect(headline).toHaveAttribute("lang", "hi");
  const hindi = await headline.textContent();
  expect(hindi).not.toBe(english);

  await page.getByTestId("hero-locale-en").click();
  await expect(headline).toHaveAttribute("lang", "en");
  await expect(headline).toHaveText(english ?? "");
});
