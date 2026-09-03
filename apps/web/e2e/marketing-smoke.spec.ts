import { expect, gotoHydrated, test } from "./fixtures";

/**
 * A24: every marketing page renders, on chromium and webkit (playwright.config.ts
 * runs every spec against both projects already — CONTRACTS §9).
 */

const MARKETING_PAGES = [
  { path: "/", name: "home" },
  { path: "/features", name: "features" },
  { path: "/styles", name: "styles gallery" },
  { path: "/pricing", name: "pricing" },
  { path: "/plugins", name: "plugins" },
  { path: "/download", name: "download" },
  { path: "/vs/kalakar", name: "vs kalakar" },
  { path: "/vs/captik", name: "vs captik" },
  { path: "/vs/submagic", name: "vs submagic" },
  { path: "/vs/autocut", name: "vs autocut" },
  { path: "/legal", name: "legal index" },
  { path: "/legal/privacy", name: "legal privacy" },
  { path: "/legal/terms", name: "legal terms" },
  { path: "/legal/aup", name: "legal aup" },
  { path: "/legal/refunds", name: "legal refunds" },
  { path: "/legal/dpa", name: "legal dpa" },
  { path: "/legal/cookies", name: "legal cookies" },
  { path: "/legal/sub-processors", name: "legal sub-processors" },
  { path: "/legal/grievance", name: "legal grievance" },
  { path: "/changelog", name: "changelog" },
  // X04: the public status page is marketing-shell chrome (header/footer),
  // same as every other page in this list, so it belongs in the same smoke
  // pass rather than a second spec file.
  { path: "/status", name: "status" },
] as const;

for (const page of MARKETING_PAGES) {
  test(`marketing smoke: ${page.name} renders one h1 and the shared chrome`, async ({
    page: browserPage,
  }) => {
    await gotoHydrated(browserPage, page.path);
    await expect(browserPage.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(browserPage.getByTestId("home-heading")).toHaveText("Aksharo");
    await expect(browserPage.getByTestId("site-footer")).toBeVisible();
  });
}

test("home renders the hero headline, the live demo and the CTA", async ({ page }) => {
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("hero-headline")).toBeVisible();
  await expect(page.getByTestId("live-caption-demo")).toBeVisible();
  await expect(page.getByRole("link", { name: /Start free/i }).first()).toHaveAttribute(
    "href",
    "/signup",
  );
});

test("primary nav reaches every page it links to", async ({ page }) => {
  await gotoHydrated(page, "/");
  const nav = page.getByTestId("site-nav");
  for (const { name, path } of [
    { name: "Features", path: "/features" },
    { name: "Styles", path: "/styles" },
    { name: "Plugins", path: "/plugins" },
    { name: "Pricing", path: "/pricing" },
    { name: "Download", path: "/download" },
  ]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await page.waitForURL((url) => url.pathname === path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await gotoHydrated(page, "/");
  }
});

test("footer legal links resolve to a real page each", async ({ page }) => {
  await gotoHydrated(page, "/");
  const footer = page.getByTestId("site-footer");
  const links = await footer.getByRole("link").all();
  expect(links.length).toBeGreaterThan(5);
  for (const link of links) {
    const href = await link.getAttribute("href");
    if (href === null || href.startsWith("mailto:") || href.startsWith("http")) continue;
    const response = await page.request.get(href);
    expect(response.ok(), `footer link ${href} should resolve`).toBe(true);
  }
});

test("comparison page for an unknown competitor 404s", async ({ page }) => {
  const response = await page.goto("/vs/not-a-real-competitor");
  expect(response?.status()).toBe(404);
});
